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
credentials you use; real process environment variables always override the
file.

| Name | Purpose |
| --- | --- |
| `YAKITORI_HOME` | User config and project registry root (default `~/.yakitori`) |
| `YAKITORI_STORE_DIR` | Session store directory (default `.yakitori`) |
| `YAKITORI_WORKSPACE` | Canonical workspace root (default `process.cwd()`) |
| `YAKITORI_GUI_DIR` | Static GUI directory served by the server (default `./dist/gui` when present) |
| `YAKITORI_MATE_ID` | Explicit active Mate when multiple exist |
| `YAKITORI_PROVIDER` | `faux` (default), `openai`, `anthropic`, `grok`, or `kimi` |
| `YAKITORI_FAUX_SCENARIO` | Faux scenario: `text`, `file`, `command`, or `error` |
| `YAKITORI_MODEL` | Required when a network provider is selected |
| `OPENAI_API_KEY` | Configures OpenAI as the default or a next-Turn provider |
| `ANTHROPIC_API_KEY` | Configures Anthropic as the default or a next-Turn provider |
| `XAI_API_KEY` | Configures Grok; when unset, each Grok Turn tries the Grok CLI OIDC login |
| `GROK_CREDENTIALS` | Grok CLI credentials file (default `~/.grok/auth.json`) |
| `KIMI_API_KEY` | Configures Kimi with an official Kimi Code console key |
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

Every provider example specifies a model so provider-default changes cannot
silently change the model recorded on a Turn. Model slugs below are examples,
not application defaults.

Example faux command flow, which runs immediately with host authority:

```sh
YAKITORI_PROVIDER=faux YAKITORI_FAUX_SCENARIO=command pnpm dev
```

Example OpenAI Responses:

```sh
YAKITORI_PROVIDER=openai YAKITORI_MODEL=gpt-5.6 OPENAI_API_KEY=… pnpm dev
```

Example Anthropic Messages:

```sh
YAKITORI_PROVIDER=anthropic YAKITORI_MODEL=claude-sonnet-4-20250514 ANTHROPIC_API_KEY=… pnpm dev
```

Example Grok through its OpenAI-Responses-compatible API. Without
`XAI_API_KEY`, Yakitori reads the official Grok CLI OIDC login. This is an
undocumented subscription path for testing only and may break or be revoked.
When the login expires, run `grok` and sign in again:

```sh
YAKITORI_PROVIDER=grok YAKITORI_MODEL=grok-4.5 pnpm dev
```

Example Kimi Code subscription using an official API key from the Kimi Code
console (`sk-kimi-…`):

```sh
YAKITORI_PROVIDER=kimi YAKITORI_MODEL=kimi-for-coding KIMI_API_KEY=… pnpm dev
```

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
