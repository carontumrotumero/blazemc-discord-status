// Pinguea un servidor de Minecraft (Server List Ping, protocolo nativo, sin
// dependencias externas) y edita un mensaje de Discord vía webhook con el
// estado actual (online/offline, jugadores, lista de nombres).
//
// Variables de entorno requeridas:
//   DISCORD_WEBHOOK_URL   URL del webhook de Discord
//   MC_HOST               Host del servidor (ej: blazemc.joinmc.world)
//   MC_PORT               Puerto del servidor (ej: 21765)
//
// Persistencia del message_id: se guarda en message_id.txt junto al script.
// El workflow de GitHub Actions commitea ese archivo si cambia, así el
// mismo mensaje se sigue editando entre ejecuciones.

import { connect } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MESSAGE_ID_FILE = path.join(__dirname, "..", "message_id.txt");

const WEBHOOK_URL = requireEnv("DISCORD_WEBHOOK_URL");
const MC_HOST = requireEnv("MC_HOST");
const MC_PORT = Number(process.env.MC_PORT ?? "25565");

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}`);
  }
  return value;
}

// ---------- VarInt helpers (protocolo Minecraft) ----------

function writeVarInt(value) {
  const bytes = [];
  let v = value;
  do {
    let temp = v & 0b01111111;
    v >>>= 7;
    if (v !== 0) temp |= 0b10000000;
    bytes.push(temp);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buffer, offset) {
  let numRead = 0;
  let result = 0;
  let pos = offset;
  let read;
  do {
    read = buffer[pos];
    pos += 1;
    const value = read & 0b01111111;
    result |= value << (7 * numRead);
    numRead += 1;
    if (numRead > 5) throw new Error("VarInt demasiado largo");
  } while ((read & 0b10000000) !== 0);
  return { value: result, length: pos - offset };
}

function writeString(str) {
  const strBuf = Buffer.from(str, "utf8");
  return Buffer.concat([writeVarInt(strBuf.length), strBuf]);
}

function writePacket(packetId, ...fields) {
  const body = Buffer.concat([writeVarInt(packetId), ...fields]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

// ---------- Server List Ping ----------

function pingServer(host, port, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let buffer = Buffer.alloc(0);
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn(arg);
    };

    const timer = setTimeout(() => {
      finish(reject, new Error("timeout"));
    }, timeoutMs);

    socket.once("error", (err) => finish(reject, err));

    socket.once("connect", () => {
      const handshake = writePacket(
        0x00,
        writeVarInt(-1), // protocol version: -1 = "no la sé, dime la tuya"
        writeString(host),
        (() => {
          const b = Buffer.alloc(2);
          b.writeUInt16BE(port, 0);
          return b;
        })(),
        writeVarInt(1), // next state: 1 = status
      );
      const statusRequest = writePacket(0x00);
      socket.write(Buffer.concat([handshake, statusRequest]));
    });

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        const { value: packetLength, length: lenBytes } = readVarInt(buffer, 0);
        if (buffer.length < lenBytes + packetLength) return; // esperar más datos

        let offset = lenBytes;
        const { value: packetId, length: idBytes } = readVarInt(buffer, offset);
        offset += idBytes;
        if (packetId !== 0x00) {
          finish(reject, new Error(`packet id inesperado: ${packetId}`));
          return;
        }
        const { value: jsonLength, length: jsonLenBytes } = readVarInt(buffer, offset);
        offset += jsonLenBytes;
        const jsonBuf = buffer.subarray(offset, offset + jsonLength);
        const json = JSON.parse(jsonBuf.toString("utf8"));
        finish(resolve, json);
      } catch {
        // datos incompletos todavía, seguimos esperando el próximo chunk
      }
    });
  });
}

// ---------- Discord ----------

async function readMessageId() {
  try {
    const content = await readFile(MESSAGE_ID_FILE, "utf8");
    const id = content.trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

async function saveMessageId(id) {
  await writeFile(MESSAGE_ID_FILE, `${id}\n`, "utf8");
}

// PowerupStack (y hosts similares) responden el ping con un servidor
// "placeholder" cuando la instancia está apagada por inactividad, en vez
// de simplemente rechazar la conexión. Lo distinguimos de offline real.
function isSleepingPlaceholder(status) {
  const versionName = status?.version?.name ?? "";
  return /sleeping/i.test(versionName);
}

function buildEmbed(status) {
  const unreachable = status === null;
  const sleeping = !unreachable && isSleepingPlaceholder(status);
  const online = !unreachable && !sleeping;

  const players = online ? status.players?.online ?? 0 : 0;
  const maxPlayers = online ? status.players?.max ?? 0 : 0;
  const sample = online ? status.players?.sample ?? [] : [];
  const names = sample.map((p) => p.name).filter(Boolean);

  let estado = "🔴 Offline";
  let color = 0xed4245;
  if (online) {
    estado = "🟢 Online";
    color = 0x57f287;
  } else if (sleeping) {
    estado = "💤 Dormido (se enciende al entrar)";
    color = 0xfee75c;
  }

  return {
    embeds: [
      {
        title: "BlazeMC — Estado del servidor",
        color,
        fields: [
          { name: "Estado", value: estado, inline: true },
          { name: "Jugadores", value: `${players}/${maxPlayers}`, inline: true },
          { name: "IP", value: `\`${MC_HOST}\``, inline: true },
          {
            name: "Conectados",
            value: names.length > 0 ? names.join(", ") : "Nadie conectado ahora mismo.",
          },
        ],
        timestamp: new Date().toISOString(),
        footer: { text: "Se actualiza solo cada 5 minutos" },
      },
    ],
  };
}

async function sendOrEditMessage(payload) {
  const existingId = await readMessageId();

  if (existingId) {
    const editRes = await fetch(`${WEBHOOK_URL}/messages/${existingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (editRes.ok) return;
    if (editRes.status !== 404 && editRes.status !== 400) {
      throw new Error(`Error editando mensaje: ${editRes.status} ${await editRes.text()}`);
    }
    // El mensaje ya no existe (fue borrado) -> creamos uno nuevo abajo.
  }

  const createRes = await fetch(`${WEBHOOK_URL}?wait=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!createRes.ok) {
    throw new Error(`Error creando mensaje: ${createRes.status} ${await createRes.text()}`);
  }
  const created = await createRes.json();
  await saveMessageId(created.id);
}

async function updateOnce() {
  let status = null;
  try {
    status = await pingServer(MC_HOST, MC_PORT);
  } catch (err) {
    console.warn(`No se pudo pinguear ${MC_HOST}:${MC_PORT}: ${err.message}`);
    status = null;
  }

  const payload = buildEmbed(status);
  await sendOrEditMessage(payload);
  console.log(`[${new Date().toISOString()}] Mensaje de Discord actualizado.`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Loopea actualizando cada UPDATE_INTERVAL_SECONDS durante LOOP_DURATION_SECONDS
// (por defecto, casi los 5 min completos hasta el próximo disparo del cron),
// para cubrir todo el intervalo en vez de actualizar solo una vez cada 5 min.
async function main() {
  const loopSeconds = Number(process.env.LOOP_DURATION_SECONDS ?? "280");
  const intervalSeconds = Number(process.env.UPDATE_INTERVAL_SECONDS ?? "20");

  const deadline = Date.now() + loopSeconds * 1000;
  do {
    await updateOnce();
    if (Date.now() >= deadline) break;
    await sleep(intervalSeconds * 1000);
  } while (Date.now() < deadline);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
