# Changelog - alexa-mcp

Bitácora cronológica de cambios significativos en este proyecto.

## Convención

- Mensajes en español, formato corto
- Solo eventos significativos (no rutinarios)
- Orden cronológico inverso: lo más reciente arriba
- Al cerrar trabajo importante: actualizar entrada y hacer commit

---

## 2026-11-17 — v1.2.0

### Límite de tasa de Amazon: backoff, cooldown y caché de estado

- `alexa_query_device` devolvía respuestas vacías (o colgaba) cuando Amazon contesta `Too many requests` (`UNOFFICIAL_CLIENT_TOO_MANY_REQUESTS`, no reintentable), y reintentar solo extendía el bloqueo.
- `alexa-client.js`: se detecta el límite en la respuesta; hasta 2 reintentos dentro de la llamada (3 s y 10 s) y después un cooldown escalante (60 s → máx. 10 min) en el que no se toca Amazon y se responde con el último estado conocido.
- Caché persistente `state-cache.json` junto a `auth.json` (escritura atómica): los dispositivos que Amazon deja sin respuesta —típico en Kasa/Hue, que solo reportan al cambiar— se sirven de la caché con `fromCache: true`.
- Timeout de 25 s por solicitud: una petición colgada ya no cuelga la llamada MCP completa.
- Nuevo parámetro `force: true` en `alexa_query_device` para saltar cooldown y caché.
- Verificado con un stub de `alexa-remote2` (11 checks): respuesta parcial, cooldown sin llamadas, `force`, persistencia entre procesos.

## 2026-11-09 — v1.1.2

### Dependencias al día y vulnerabilidades corregidas

- `alexa-remote2` 8.0.4 → 8.1.1, `@modelcontextprotocol/sdk` 1.29.0 → 1.32.2, `zod` 4.4.3 → 4.6.7. Los rangos mínimos de `package.json` suben para que una instalación nueva no traiga versiones vulnerables.
- `npm audit`: de 13 vulnerabilidades (1 crítica, 7 altas) a 3 bajas. Las que quedan son `cookie` vía `alexa-cookie2` (upstream); `npm audit fix --force` bajaría `alexa-remote2` a 1.0.3, así que no se aplica.
- `index.js`: la versión que reporta el server ahora se lee de `package.json` (estaba fija en `1.0.0`).
- Verificado en `personal` y `pa`: handshake MCP, 18 tools y `alexa_list_devices` OK; el refresco de token se persistió completo.

## 2026-09-22 — v1.1.1

### La sesión de Amazon ya no se cae a cada rato

- Causa: `init()` pasaba la cookie como texto; sin el objeto de registro, `alexa-remote2` no recupera `macDms` y **refrescaba el token contra Amazon en cada arranque**. El token nuevo nunca se guardaba, así que el siguiente arranque partía de uno ya rotado y pedía login.
- `alexa-client.js`: se entrega el registro completo (con `macDms`), así que mientras el token tenga menos de 24 h no hay llamada a Amazon. Los refrescos reales (nuevo `tokenDate`) sí se persisten.
- `_saveAuth()`: valida que el registro esté completo, escribe de forma atómica (`.tmp` + rename) y deja `auth.json.prev` como respaldo.
- `auth.js`: guarda el `amazonPage` real de la cuenta (antes fijo `amazon.com`, lo que rompía cuentas de otros dominios como `amazon.com.mx`).
- Verificado en la instancia `personal`: 5 arranques seguidos sin refresco y `auth.json` intacto.

## 2026-05-15 — v1.1.0

### Soporte multi-instancia

- Nueva env var `ALEXA_MCP_AUTH_DIR` permite que un solo clone del repo sirva varias cuentas de Alexa, cada una con su propio `auth.json`. Default sigue siendo `.auth-data/` del proyecto (compat hacia atrás).
- `auth.js`: añadido fallback que persiste la cookie aunque el registro post-auth de Amazon falle (cuentas con device-registration con quirks).

### Setup interno

- Migración a arquitectura "una codebase, múltiples instancias":
  - `homeassistant` → `~/.alexa-mcp/personal/auth.json`
  - `homeassistant-pa` → `~/.alexa-mcp/pa/auth.json`
- `alexa-mcp-pa/` archivado como `alexa-mcp-pa.bak/` (a borrar cuando ya no se necesite).

## 2026-05-15 — v1.0.0

### Initial public release

- Repo publicado en <https://github.com/RenatoAscencio/alexa-mcp>
- Bump @modelcontextprotocol/sdk → 1.29.0, zod → 4.4.3 (deps actualizadas, vulnerabilidades altas/moderadas resueltas)
- README en inglés, LICENSE MIT

## 2026-05-11

### Bitácora iniciada

- Inicializado git + CHANGELOG.md en este proyecto
- Convención de versionado documentada
