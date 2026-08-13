# 0014: Run the Desktop Server as a Sidecar Child Process

## Status

Accepted on 2026-08-11. Supersedes the in-process embedding half of decision
0010 ("Electron main embeds the application in-process"); the same-origin
serving and HTTP-only-channel parts of 0010 are unchanged.

## Context

Decision 0010 ran the whole application inside the Electron main process. In
daily development this hurts: Electron main has no hot-reload story, so every
server-code edit required a manual bundle rebuild and a full Electron restart.
Peer products keep the core out of the shell process — the Codex app spawns
`codex app-server`, OpenCode runs a separate server, Claude Code spawns CLI
children.

The in-process topology also forced the vite dev server to proxy individual
API routes for the browser dev flow, a recurring "forgot to add a proxy route"
bug class.

## Decision

### Thin shell, sidecar server

`src/desktop/main.ts` only spawns/manages the server child and the window.
The server runs as a separate Node process in both dev and prod — no
dev/prod topology divergence:

- **Dev** (`ELECTRON_RENDERER_URL` set): the shell spawns
  `node --watch src/server/start.ts` from the checkout. Server edits restart
  the child without touching the window; the fixed dev port keeps the GUI's
  API param valid across restarts.
- **Prod** (packaged): the shell spawns the bundled
  `src/server/desktop-entry.ts` build (`dist/desktop/server.js`) with
  `process.execPath` + `ELECTRON_RUN_AS_NODE=1`. The entry is unpacked from
  the asar archive (`asarUnpack`), because a plain Node child cannot read
  inside asar.

### URL over stdout, never a guessed port

The child binds and prints one machine-readable line,
`yakitori-listening http://127.0.0.1:<port>`, which the parent parses out of
arbitrary log noise (`src/desktop/server-process.ts`). Prod binds an ephemeral
port (`PORT=0`), killing the port-collision class of bugs; dev keeps a pinned
port so watch restarts keep the same URL. The renderer targets the API origin
directly — `?api=<url>` on the vite dev URL in dev, same-origin from the
sidecar in prod — so the vite proxy table is deleted entirely.

Shutdown escalates SIGTERM → SIGKILL on the child; an unexpected child exit
quits the shell with an error instead of leaving a zombie window.

### Alternatives considered

- **Keep embedding in-process** (0010's choice): the dev-loop pain above is
  structural; no Electron main-process HMR exists anywhere.
- **IPC bridge instead of HTTP**: rejected with 0010 — the HTTP API stays the
  only GUI↔core channel.

## Consequences

- Server development needs no Electron restart; `pnpm dev:desktop` is the
  fast loop.
- The browser dev flow (`pnpm dev`) loses the vite proxy: the GUI must be
  opened with `?api=http://127.0.0.1:4141`. The API origin is startup wiring,
  not an end-user switcher in the workbench.
- Packaging ships `dist/desktop/server.js` unpacked; `electron-builder.yml`
  carries the `asarUnpack` rule.
- `src/server/start.ts` gained a bounded shutdown helper
  (`src/server/shutdown.ts`): HTTP close force-drops SSE/keep-alive
  connections, and both the server close and the application close are
  deadline-bounded so a wedged connection can never stall shutdown.
