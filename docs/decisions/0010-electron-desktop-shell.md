# 0010: Ship the Workbench as an Electron Desktop App Served by Its Own Server

## Status

Accepted on 2026-07-31. This decision records the product-packaging direction
and the server-served-GUI boundary it required. It does not change any kernel,
persistence, or API contract.

## Context

The workbench ran as two browser-era pieces: a local HTTP server
(`127.0.0.1:4141`, JSON API + SSE) and a vite dev server / static build for the
React GUI. The product call is that Yakitori is a native desktop application,
not a web page the user opens in a browser tab.

The GUI already talks to the server over plain HTTP on localhost, and the
server deliberately restricts CORS to `http:` origins on loopback. Loading the
built GUI through `file://` would send a `null` Origin and fail that boundary;
relaxing CORS for `null` would widen the API's exposure for packaging
convenience.

## Decision

### One server serves the whole app

The HTTP server optionally serves the built GUI from a configurable directory
(`guiStaticDir` application option, `YAKITORI_GUI_DIR` env, default
`<cwd>/dist/gui` when it exists):

- API routes (`/health`, `/sessions`) keep their exact JSON behavior; unknown
  API-shaped paths keep JSON errors.
- Other GET paths resolve inside the static directory with traversal
  containment; misses fall back to `index.html` (SPA fallback).
- Content-hashed files under `/assets/` are cached immutably; everything else
  is `no-cache`. GET only.

This makes the app same-origin by construction: no CORS exceptions, one port,
one process to reason about. The vite dev workflow is unchanged — when the
static directory is absent the server behaves exactly as before.

### Electron main embeds the application in-process

`src/desktop/main.ts` (bundled by vite's `desktop` mode to
`dist/desktop/main.js`, ESM) creates the yakitori application itself — no child
process, no second runtime — starts the HTTP server, and loads the served URL
in one `BrowserWindow`:

- The server binds `127.0.0.1` on an ephemeral port by default; `PORT` pins it
  for the dev-HMR flow (`ELECTRON_RENDERER_URL` points the window at vite
  instead, with bounded reload retries while vite starts).
- Storage keeps the existing project-local semantics: workspace is
  `YAKITORI_WORKSPACE` or `process.cwd()`, the store is
  `YAKITORI_STORE_DIR` or `<workspace>/.yakitori`.
- Window hardening is the Electron consensus baseline: default sandbox and
  context isolation, no Node integration in the renderer, `window.open`
  denied, cross-origin navigation blocked.
- Quitting closes the HTTP server (including SSE connections) and the
  application through its existing idempotent `close()`.

Packaging uses electron-builder (unsigned `dir` target for now;
`pnpm package:desktop`). The desktop bundle inlines all runtime dependencies,
so `node_modules` is not shipped. Electron 43 embeds Node 24, verified to
provide `node:sqlite` without flags — the Mate store works unchanged.

### Alternatives considered

- **Tauri**: would force re-hosting the Node server (sidecar) or rewriting it
  in Rust, and adds a Rust toolchain to every contributor loop. The harness is
  deliberately Node; nothing in the product needs Tauri's smaller footprint
  today.
- **Browser-only "web app"**: rejected on product grounds — the workbench is a
  native application.
- **`file://` GUI loading**: fails the loopback CORS boundary by design and
  complicates asset URLs; same-origin serving is strictly simpler.
- **Server as a child process**: extra lifecycle, IPC, and packaging surface
  for no capability gain; in-process startup is one `await`.

## Consequences

- `pnpm start:desktop` runs the production-style app (build GUI + desktop
  bundle, launch Electron against the embedded server). `pnpm dev:desktop`
  keeps vite HMR against the embedded server on port 4141. `pnpm dev`
  (browser) remains supported.
- The HTTP API remains the only GUI↔core channel; Electron adds no
  privileged IPC bridge. Anything the window can do, a local HTTP client can
  do — the API boundary stays the single integration surface.
- Static serving is a narrow, GET-only addition guarded by an absent-by-default
  option; the API surface is unchanged.

## Deferred Work

- **Workspace selection for packaged builds.** Launched from Finder,
  `process.cwd()` is `/`, so the default workspace/store resolution is wrong
  for real desktop use. A workspace picker (or a user-data default with an
  explicit project-open flow) is required before shipping packaged builds.
- Signed/notarized `dmg` targets, auto-update, single-instance lock, and app
  menus/tray integration.
- Serving multiple windows or per-window session routing.
