# Yakitori

Yakitori is a from-scratch learning project for building a local coding-agent
harness and GUI. The current priority is a solid single-Mate coding agent.
Persistent-memory Mates collaborating in shared task Rooms are the later
product direction, not an implemented capability.

The goal is to understand the runtime and product boundaries behind modern
coding agents by implementing them directly, one reviewable module at a time.
Yakitori learns from public references but does not wrap or depend on an
existing agent framework.

## Goals

- Build a local coding-agent harness from first principles.
- Give each Mate a durable identity, versioned profile, governed memory, and
  inspectable history across Tasks.
- Let several Mates eventually work on the same Task concurrently, publish
  findings to one Room, and use structured mentions to request attention.
- Keep shared Messages distinct from per-recipient Deliveries and from each
  Mate's private execution Session.
- Keep the core responsible for structured execution, tools, permissions,
  persistence, and honest recovery.
- Build a GUI task workbench for discussion, Mate activity, terminal, diff,
  approvals, artifacts, worktrees, and memory provenance.
- Record coarse, truthful facts sufficient for debugging, repair, and
  evaluation without persisting every runtime transition.
- Keep each module small enough to understand and replace.

## Product Direction

The target shape is:

```text
Codex-style coding task workbench
+ persistent Mates and governed memory
+ shared Room collaboration and structured @mentions
+ one inspectable execution lane per Mate Assignment
```

## Local Run

Yakitori requires Node.js 24 or newer and uses pnpm 11.7.0.

Install dependencies:

```sh
pnpm install
```

Run the desktop app in production style. This builds the GUI and desktop
bundle, spawns the bundled server as a sidecar, and serves the GUI same-origin:

```sh
pnpm start:desktop
```

Run desktop development with Vite HMR. The shell spawns `node --watch` for the
server, so server edits restart the sidecar without restarting the window:

```sh
pnpm dev:desktop
```

Run the server and GUI in a browser instead:

```sh
pnpm dev
```

- GUI: `http://127.0.0.1:5173?api=http://127.0.0.1:4141`
- Default API: `http://127.0.0.1:4141`
- The Vite dev server has no API proxy. The `api` query parameter, or the
  remembered `yakitori.apiBase`, points the GUI at the server.
- When `dist/gui` exists, the server also serves the built GUI. After
  `pnpm build:gui`, open `http://127.0.0.1:4141` directly.

### Environment variables

Both `pnpm dev:server` and the desktop shell load a gitignored `.env` from the
checkout root. Copy `.env.example` to `.env` and fill in only the provider
credentials you explicitly bind to an account; real process environment
variables always override the file. Keys in the environment do not create
accounts. Add accounts in Settings → Providers → Accounts, then choose a model
in the composer. An empty installation starts with account setup available.

| Name | Purpose |
| --- | --- |
| `YAKITORI_HOME` | User config and project registry root (default `~/.yakitori`) |
| `YAKITORI_STORE_DIR` | Session store directory (default `YAKITORI_HOME`) |
| `YAKITORI_WORKSPACE` | Canonical workspace root (default `process.cwd()`) |
| `YAKITORI_GUI_DIR` | Static GUI directory served by the server (default `./dist/gui` when present) |
| `YAKITORI_ASSET_BASE_URL` | Optional externally accessible asset route base, including any deployment path prefix |
| `YAKITORI_MATE_ID` | Explicit active Mate when multiple exist |
| `YAKITORI_PROVIDER` | Optional initial model namespace or saved account ID; `faux` enables the scripted development transport |
| `YAKITORI_FAUX_SCENARIO` | Faux scenario: `text`, `file`, `command`, or `error` |
| `YAKITORI_MODEL` | Initial model ID, used with `YAKITORI_PROVIDER` after accounts are configured |
| `OPENAI_API_KEY` | Available to accounts explicitly using this environment variable |
| `ANTHROPIC_API_KEY` | Available to accounts explicitly using this environment variable |
| `XAI_API_KEY` | Available to accounts explicitly using this environment variable |
| `GROK_CREDENTIALS` | Grok CLI credentials file (default `~/.grok/auth.json`) |
| `KIMI_API_KEY` | Available to Kimi Code accounts explicitly using this environment variable |
| `EXA_API_KEY` | Optional; raises the Exa free-tier quota used by `web_search` |
| `HOST` / `PORT` | Server listen address (default `127.0.0.1:4141`) |

Shell commands inherit the complete user environment by default. Optional
Codex-style filtering is configured in `~/.yakitori/config.toml`:

```toml
[shell_environment_policy]
inherit = "core"                  # all (default) | core | none
ignore_default_excludes = false   # drop *KEY* / *SECRET* / *TOKEN*
exclude = ["ACME_*", "CI_*"]
include_only = ["PATH", "HOME", "MY_FLAG"]

[shell_environment_policy.set]
MY_FLAG = "1"
```

To connect a network model, add an account with a saved key, one named
environment variable, or the explicit subscription sign-in/import flow. A
missing credential requires reconnecting that account. There is no fallback
between saved keys, environment variables, and CLI login files. Existing CLI
credentials are used only after the user connects them from Accounts.

For a scripted command flow that runs immediately with host authority:

```sh
YAKITORI_PROVIDER=faux YAKITORI_FAUX_SCENARIO=command pnpm dev
```

The model picker lists model identities across connected accounts. The host
chooses an eligible account before creating a Turn and retains that account for
its requests and retries. Account-local deployment aliases are equivalent only
when their model configuration explicitly declares the same identity. External
ACP engines remain separate execution owners.

This account model intentionally replaces automatic provider registration.
Older configurations that relied on environment detection or a provider's name
must be recreated with an explicit service and authentication source.

Never commit API key values. `pnpm test` and `pnpm check` never require network
access or credentials.

## Verification and Development Commands

Run the full local check:

```sh
pnpm check
```

Recommended before delivery:

```sh
pnpm format
pnpm check
pnpm build
```

Other useful commands:

```sh
pnpm dev:gui
pnpm dev:server
pnpm typecheck
pnpm test
pnpm test:watch
pnpm lint
pnpm build:desktop
pnpm package:desktop
```

The build writes the GUI to `dist/gui`, and the Electron main bundle plus
sidecar server entry to `dist/desktop`. `pnpm package:desktop` produces an unsigned, unnotarized,
unpacked app under `release/`.

### Installing the latest main build

The Desktop workflow packages the app on every push to `main` and keeps the
result as the `yakitori-macos-arm64` workflow artifact. With the `gh` CLI
authenticated, one command downloads that build and installs it to
`/Applications`:

```sh
pnpm install:main
```

When no CI build is available (or for a build straight from the local
checkout's `origin/main`), append `--local` to package it in a throwaway git
worktree instead; the current checkout and its native module builds stay
untouched:

```sh
pnpm install:main --local
```
