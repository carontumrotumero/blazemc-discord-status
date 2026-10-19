# blazemc-discord-status

Mantiene un único mensaje de Discord editándose solo cada 5 minutos con el
estado en vivo de BlazeMC: online/offline, jugadores conectados/máximo y
lista de nombres. Corre gratis en GitHub Actions, sin servidor propio.

## Cómo funciona

1. Cada 5 minutos, GitHub Actions ejecuta `scripts/update-status.mjs`.
2. El script le hace un *ping* directo al servidor (protocolo nativo de
   Minecraft, el mismo que usa el cliente para mostrar el server en la
   lista de servidores) — no necesita el panel ni login.
3. Edita (o crea, la primera vez) un mensaje en el canal de Discord que
   apunta el webhook.
4. El ID del mensaje creado se guarda en `message_id.txt` y Actions lo
   commitea de vuelta al repo, así la próxima ejecución edita el mismo
   mensaje en vez de crear uno nuevo.

## Setup (una sola vez)

### 1. Crear el webhook en Discord

En el servidor de Discord: **Configuración del servidor → Integraciones →
Webhooks → Nuevo Webhook**. Elegí el canal, copiá la URL del webhook.

### 2. Configurar el repo en GitHub

En **Settings → Secrets and variables → Actions**:

- **Secrets** (pestaña *Secrets*) → *New repository secret*:
  - `DISCORD_WEBHOOK_URL` = la URL del webhook que copiaste.
- **Variables** (pestaña *Variables*) → *New repository variable*:
  - `MC_HOST` = `blazemc.joinmc.world`
  - `MC_PORT` = `21765`

### 3. Activar el workflow

Hace falta un primer push o ejecutar el workflow manualmente una vez desde
la pestaña **Actions → Update Discord status → Run workflow** para que
GitHub Actions empiece a correr el cron.

## Cambiar qué se muestra

Todo el formato del mensaje (embed) está en `buildEmbed()` dentro de
`scripts/update-status.mjs` — se puede tocar el texto, colores, o qué
campos se muestran sin tocar nada más.

## Intervalo de actualización

El repo es público, así que los minutos de Actions son gratis e
ilimitados. El `cron` de GitHub Actions **no es confiable para
intervalos cortos** — en la práctica puede atrasarse una o varias horas
en vez de disparar cada 5/10 minutos como dice el YAML (esto se
confirmó empíricamente: dos corridas programadas llegaron a tener 1h y
2h de diferencia). Por eso la actualización en tiempo real no depende
del cron para nada:

1. Cada corrida queda loopeando, actualizando el mensaje cada
   `UPDATE_INTERVAL_SECONDS` (2s por defecto — el margen seguro contra
   el rate-limit del webhook de Discord, ~5 requests cada 2s).
2. Corre así durante `LOOP_DURATION_SECONDS` (casi 6 horas por defecto,
   el máximo que permite un job de Actions).
3. Justo antes de terminar, se **auto-dispara a sí misma** vía la API de
   GitHub (`workflow_dispatch`), así la siguiente corrida arranca sin
   esperar al cron — solo el tiempo de `checkout` + `setup-node`
   (~20-30s), no horas.

El `cron: "*/10 * * * *"` que queda en el YAML es solo una red de
seguridad por si esa cadena se llegara a cortar (por ejemplo, si alguien
cancela una corrida a mano); no es el mecanismo real de actualización.

Si Discord devuelve 429 en algún momento puntual del loop, el script lo
loguea y sigue con la próxima vuelta en vez de cortar todo.

### Probar el auto-encadenado sin esperar 6 horas

Desde **Actions → Update Discord status → Run workflow**, tildar
"Loop corto (30s)" — esa corrida dura 30s y al final intenta disparar la
siguiente, así se puede confirmar que el encadenado funciona sin
esperar el ciclo completo.

Ambas variables se pueden ajustar como env vars del step en
`.github/workflows/update-status.yml` si se quiere un intervalo distinto.

Nota: el disparo del cron en sí (`cron: "*/5 * * * *"`) puede atrasarse
algunos minutos en momentos de mucha carga en GitHub — es una limitación
de la plataforma, no del código.

