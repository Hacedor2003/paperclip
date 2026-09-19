# recordar.md — decisiones de seguridad de este fork

Notas de mantenimiento del fork `Hacedor2003/paperclip`. **Lee esto antes de
hacer merge con upstream (`paperclipai/paperclip`)**: varios cambios de abajo
son divergencias deliberadas respecto a upstream y van a aparecer como
conflictos. La columna "al mergear" dice qué defender.

Auditoría inicial: 2026-09-17, sobre `165b10b`. El fork estaba a la par de
upstream, sin commits propios.

---

## 1. Cambios aplicados

### 1.1 El agente ya no hereda los secretos del servidor

**Problema.** Los 8 adaptadores locales lanzaban el CLI del agente con
`{ ...process.env, ...env }`. El `.filter()` de esas líneas solo descarta
`undefined` — no filtra nada por seguridad. El único denylist existente
(`isForbiddenConfigEnvKey`) bloquea **una** variable, `PAPERCLIP_API_KEY`, y
solo de la config, no del entorno heredado. Resultado: el proceso del agente
veía `DATABASE_URL`, `BETTER_AUTH_SECRET`, `PAPERCLIP_SECRETS_MASTER_KEY` y las
credenciales AWS del host. El prompt de ese agente se construye con cuerpos de
issues, mensajes de chat y payloads de webhook, o sea contenido que viene de
fuera de la frontera de confianza.

**Cambio.** Nueva función `sanitizeInheritedHostEnv()` en
`packages/adapter-utils/src/server-utils.ts`, aplicada en los ~25 puntos de
spawn de `packages/adapters/*/src/server/{execute,test,models}.ts`.

Es un **denylist, no un allowlist**. Un allowlist rompería todas las
ejecuciones: el agente necesita `PATH`, `HOME`, locale, proxy y las API keys de
proveedor (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`…), que se
conservan a propósito.

Se elimina: `DATABASE_URL`, `BETTER_AUTH_SECRET`,
`PAPERCLIP_SECRETS_MASTER_KEY(_FILE)`, `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET`,
`PAPERCLIP_ID_CONNECTOR_{SIGN,SEAL}_PRIVATE_KEY`, tokens de backend de
telemetría/feedback, `PAPERCLIP_PAGE_AWS_*`, `AWS_SECRET_ACCESS_KEY`,
`AWS_SESSION_TOKEN`, más los patrones `PAPERCLIP_*{SECRET,PRIVATE_KEY,MASTER_KEY,SIGNING_KEY}`
y `BETTER_AUTH_*SECRET`.

**Escape:** `PAPERCLIP_AGENT_ENV_PASSTHROUGH=CLAVE_A,CLAVE_B` readmite claves
concretas. Se lee **solo** del entorno del host, nunca de la config del
adaptador ni del prompt, para que no se pueda ensanchar desde dentro de un run.

**Al mergear:** defender el cambio. Si upstream añade un punto de spawn nuevo,
buscar `...process.env,` en `packages/adapters/` y aplicarle la función.

### 1.2 Se dejan de pisar los ajustes de permisos del usuario

**Problema.** `writePaperclipClaudeSettings()` en
`packages/adapter-utils/src/acpx-engine/execute.ts` escribía
`.claude/settings.local.json` en el worktree del run y hacía dos cosas que
nadie autorizó:

- bajaba un `defaultMode: "dontAsk"` puesto por el usuario a `"default"`;
- pre-aprobaba `Bash(curl:*)`, `Bash(env:*)` y `Bash(env)`.

Juntas, `env` + `curl` son literalmente un primitivo de exfiltración
pre-aprobado: leer todos los secretos del proceso y hacer POST a donde sea, sin
humano en el bucle.

**Cambio.**

- Fuera las tres reglas `curl`/`env`. Quedan solo los helpers estrechos del
  control plane (`scripts/paperclip-issue-update.sh`, `scripts/paperclip`).
- `dontAsk` del usuario se respeta.

**⚠️ Efecto secundario real, tenlo presente:** con `dontAsk`, el SDK de Claude
Code deniega en silencio toda herramienta que no esté en el allow list y nunca
llega a `canUseTool`. Si tienes `defaultMode: "dontAsk"` en tu
`~/.claude/settings.json`, **tus runs desatendidos se van a quedar sin
herramientas**. Si eso pasa, tienes dos salidas:

1. `PAPERCLIP_OVERRIDE_USER_PERMISSION_MODE=1` — restaura el comportamiento de
   upstream (vuelve a pisar `dontAsk`).
2. Quitar `dontAsk` de tu config global y usar un modo menos restrictivo.

La nota de arranque del run dice cuál de los dos caminos se tomó: busca
`honored user dontAsk` u `overrode user dontAsk` en los command notes.

**Al mergear:** defender. Upstream tiene un comentario explícito de que quiere
pisar `dontAsk`; el conflicto es de política, no de código.

### 1.3 Telemetría y anuncios: opt-in en vez de opt-out

**Problema.** `telemetryEnabled` venía `?? true` y `client.ts` lleva dos
endpoints fijos: `https://telemetry.paperclip.ing/ingest` y un API Gateway de
AWS (`rusqrrg391.execute-api.us-east-1.amazonaws.com`). Una instancia
self-hosted empezaba a hablar con infraestructura de terceros antes de que su
operador decidiera nada. Igual `announcementsEnabled`, que hace polling a
`https://pages.paperclip.ing/announcements/v1/current.json`.

Para ser justos con upstream: está documentado en `README.md:493-508`, no manda
prompts ni rutas ni secretos, y hashea las refs de repos privados con salt por
instalación. El problema es el default, no el diseño.

**Cambio.**

| Dónde | Antes | Ahora |
|---|---|---|
| `packages/shared/src/telemetry/config.ts` | activo salvo opt-out | requiere `telemetry.enabled: true` o `PAPERCLIP_TELEMETRY_ENABLED=1` |
| `server/src/config.ts` `telemetryEnabled` | `?? true` | `?? false` |
| `server/src/config.ts` `announcementsEnabled` | `!== "false"` | `=== "true"` |

Los opt-out de upstream (`PAPERCLIP_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`,
`CI=true`) siguen funcionando; ahora son redundantes.

**Al mergear:** defender los tres defaults.

### 1.4 Dependencias: 15 vulnerabilidades altas → 0

`multer` era dependencia **directa** de `server/` en `^2.2.0` (3 DoS
distintos). Subida a `^2.3.0`. Las demás eran transitivas y se fijaron con
`pnpm.overrides` en el `package.json` raíz:

```
fast-uri >=3.1.6   (SSRF vía IPv6 malformado y percent-decoding repetido)
undici >=6.27.0    (3 DoS en el cliente WebSocket)
path-to-regexp >=8.4.0
form-data >=4.0.6  (inyección CRLF)
js-yaml >=4.3.2
multer >=2.3.0
```

`pnpm audit`: antes 38 (15 high), ahora 12 (0 high, 0 critical, 10 moderate,
2 low). **Revisar estos overrides después de cada merge con upstream** — si
upstream sube las versiones, los overrides sobran y conviene quitarlos.

---

## 2. Pendiente — es operativo, no código

No se puede arreglar desde el repo. Son ajustes de tu instancia.

- **Deja `enableConferenceRoomChat` apagado.** `server/src/routes/board-chat.ts`
  lanza `claude --dangerously-skip-permissions` con `env: {...process.env}` y
  `cwd: /tmp`. Está bien cercado (flag experimental + `deploymentMode ===
  "local_trusted"` + `assertCompanyAccess`), pero el historial que recibe el
  modelo incluye comentarios escritos por **agentes** e integraciones externas
  etiquetados como turnos `user`. Si lo activas, quien pueda comentar en el
  issue "Board Operations" escribe en un prompt que ejecuta shell en tu máquina.
- **`dangerouslySkipPermissions: false`** en los agentes que procesen contenido
  externo (issues de GitHub, Telegram, email). Por defecto es `true` en
  `claude-local`; `cursor-local` añade `--yolo`, `gemini-local`
  `--approval-mode yolo`, `hermes` `--yolo` siempre. El cambio 1.1 reduce el
  daño (ya no hay secretos del servidor que robar) pero **no** impide que un
  prompt inyectado ejecute comandos.

---

## 3. Verificado — no hace falta volver a auditarlo

Descartado explícitamente en la auditoría inicial. Si alguien vuelve a
preguntar "¿el fork hace cosas raras?", la respuesta está aquí.

- **No hay dar-estrella ni acciones sociales en GitHub.** Los `starred` del
  código son un campo propio de la BD (`resource-memberships.ts`), favoritos
  internos.
- **No hay navegación web oculta.** Playwright solo en `scripts/` de dev y
  tests. El navegador solo se abre en el login del CLI
  (`cli/src/client/board-auth.ts`), desactivable con `PAPERCLIP_NO_BROWSER`.
- **Los 11 `patches/` son legítimos** — adaptaciones de chat-adapters/ACP, sin
  exfiltración.
- **El `postinstall` no toca la red** — `scripts/link-plugin-dev-sdk.mjs` solo
  crea symlinks locales.
- **No hay auto-publicación** a Discord/Twitter/GitHub desde el servidor.

Y esto está **bien hecho por upstream — no lo rompas al personalizar**:

- `server/src/services/remote-http-fetch.ts`: defensa SSRF ejemplar. Resuelve
  DNS una vez, fija la IP aprobada, **verifica la dirección real del socket
  antes de escribir un byte**, y nunca sigue redirecciones. Cierra DNS
  rebinding de verdad.
- Secretos en reposo: AES-256-GCM, clave maestra de 32 bytes en fichero `0600`.
- Firmas de webhook: HMAC + `timingSafeEqual` dentro de `try/catch`, ventana
  anti-replay de 300 s en Slack.
- `server/src/index.ts:654-663`: `local_trusted` da admin implícito **sin
  autenticación**, pero el arranque **lanza excepción** si el bind no es
  loopback. Docker usa `authenticated` por defecto. No toques esa guarda.
- Sin `shell: true` en ninguna parte; `execFile` con argumentos en array.
- CI: `pull_request_target` hace checkout de `master`, nunca del código del PR,
  y pasa los datos del PR como variables de entorno, no interpoladas en `run:`.

---

## 4. Cómo verificar los cambios

Este repo exige Node >= 24.11.0 (`.nvmrc` = 24) y pnpm 9.15.4.

```bash
pnpm install
pnpm --filter @paperclipai/adapter-utils typecheck
./node_modules/.bin/vitest run packages/adapter-utils packages/adapters
./node_modules/.bin/vitest run packages/shared
pnpm audit --audit-level=high
```

### Fallos de test que NO son tuyos

Verificados contra el árbol sin modificar (`git stash`) — fallan igual en
upstream. Son artefactos de correr como **root** en contenedor:

- `execution-target-stdin-race.test.ts` → T18, T19: simulan `EACCES` con
  permisos de fichero; root los ignora.
- `acpx-engine/execute.test.ts` → `test_idle_staged_runtime_cleanup_waits_for_active_turn_release`
  y `test_sandbox_startup_span_ends_exactly_once_on_every_exit_path`: timeout
  de 5000 ms, el contenedor va lento.
- Cualquier test con Postgres embebido: `initdb` se niega a correr como root.
- `tsc --noEmit` en `server/`: 140 errores preexistentes, todos derivados de
  que `@paperclipai/plugin-sdk` no está compilado (`TS2307` en cascada). Se van
  con `pnpm build`.

Tras los cambios: adapters + adapter-utils quedan en 1219 passed / 4 failed
(los 4 de arriba), shared en 749/749.
