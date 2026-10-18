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
ilimitados. Para que sea prácticamente en tiempo real sin depender de
que el cron de GitHub dispare cada minuto (cosa que GitHub no garantiza
por debajo de ~5 min), cada ejecución no actualiza una sola vez: queda
corriendo en un loop interno actualizando cada `UPDATE_INTERVAL_SECONDS`
(2s por defecto) durante `LOOP_DURATION_SECONDS` (290s por defecto, casi
los 5 minutos completos), hasta que el próximo disparo del cron la
releva. El intervalo de 2s es a propósito: es el margen seguro para no
pegarle al rate-limit de Discord en el webhook (~5 requests cada 2s).
Si Discord igual devuelve 429 en algún momento puntual, el script lo
loguea y sigue con la próxima vuelta en vez de cortar todo.

Ambas variables se pueden ajustar como env vars del step en
`.github/workflows/update-status.yml` si se quiere un intervalo distinto.

Nota: el disparo del cron en sí (`cron: "*/5 * * * *"`) puede atrasarse
algunos minutos en momentos de mucha carga en GitHub — es una limitación
de la plataforma, no del código.

