# Yakitori

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-CN.md">简体中文</a>
</p>

Yakitori is a from-scratch learning project for building a local coding-agent
harness and GUI. Its product direction is a coding workbench centered on
persistent-memory `Mate`s that can work alone or collaborate in a shared
task room.

The goal is to understand the runtime and product boundaries behind modern
coding agents by implementing them directly, one reviewable module at a time.
Yakitori learns from public references but does not wrap or depend on an
existing agent framework.

## Goals

- Build a local coding-agent harness from first principles.
- Give each Mate a durable identity, versioned profile, governed memory,
  and inspectable history across tasks.
- Let several Mates work on the same Task concurrently, publish findings to
  one Room, and use structured mentions to request attention.
- Keep shared Messages distinct from per-recipient Deliveries and from each
  Mate's private execution Session.
- Keep the core responsible for structured execution, collaboration, tools,
  permissions, persistence, and honest recovery.
- Build a GUI task workbench for shared discussion, Mate activity, terminal,
  diff, approvals, artifacts, worktrees, and memory provenance.
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

A Room is not a copy of Slack or Raft's full product shell. It is the shared
communication boundary inside the coding workbench. A Room Message is stored
once; durable Deliveries decide which Mates should catch up, wake, or steer.
Detailed tool output stays in each Mate's execution Session unless the
Mate explicitly publishes a bounded finding or artifact reference.

## Non-goals

- Do not use LangGraph, AutoGen, OpenAI Agents SDK, Claude Agent SDK, or similar
  orchestration frameworks.
- Do not make runtime code depend on local reference repositories.
- Do not clone product behavior wholesale. Reference projects are used for
  comparison and learning.
- Do not treat a Mate as a permanently running process or silently promote
  every transcript message into long-term memory.
- Do not turn the GUI into a general-purpose channel application or task board.

## Reference Material

Local reference material may live under `.references/`, which is ignored by
git. Current intended references are:

- `.references/public/codex` for the primary workbench and system reference
- `.references/public/opencode-v2` for durable input, transaction, and recovery
  mechanisms
- `.references/public/opencode` for legacy v1 comparison only
- `.references/public/pi` for a small model loop and provider/tool boundaries
- `.references/public/claude-code-sourcemap` as an unofficial research aid
- public Claude Code documentation and observable behavior for permissions,
  hooks, instructions, and terminal product behavior
- public Raft documentation and observable behavior for the persistent
  colleague and collaboration product promise, not its complete product shape

Reference material is not part of the project source tree and should not be
required to build, test, or run Yakitori.

## Current Status

Stage 1 MVP runtime is implemented as one vertical slice:

- a witness-style Session/Input/Turn kernel with 13 coarse durable facts
- transactional write-through Session projections; replay is a repair tool
- Mate profile store + default active Mate selection at application startup
- SessionRunner with single-flight wakes, bounded model context, and recovery
- scripted faux provider (default tests), OpenAI Responses adapter, and
  optional Anthropic Messages adapter
- bounded tools: `read_file`, `write_file` (compare-and-write), `run_command`
- durable permission gate for host commands (never auto-approved in production)
- dual event delivery: durable SSE (`session.event`) + transient snapshots
- GUI execution feed with streaming, tool/permission cards, cancel, and diagnostics

Still deferred to later stages: Room/Task/Assignment/Delivery collaboration,
governed memory, worktrees, multi-provider selection UI, compaction, subagents.

## Local Run

Install:

```sh
pnpm install
```

Run server + GUI:

```sh
pnpm dev
```

- GUI: `http://127.0.0.1:5173`
- API default: `http://127.0.0.1:4141`

### Environment variables

| Name | Purpose |
| --- | --- |
| `YAKITORI_STORE_DIR` | Store directory (default `.yakitori`) |
| `YAKITORI_WORKSPACE` | Canonical workspace root (default `process.cwd()`) |
| `YAKITORI_MATE_ID` | Explicit active Mate when multiple exist |
| `YAKITORI_PROVIDER` | `faux` (default), `openai`, or `anthropic` |
| `YAKITORI_FAUX_SCENARIO` | Faux scenario: `text`, `file`, `command`, `error` |
| `YAKITORI_MODEL` | Required when a network provider is selected |
| `OPENAI_API_KEY` | Required when `YAKITORI_PROVIDER=openai` |
| `ANTHROPIC_API_KEY` | Required when `YAKITORI_PROVIDER=anthropic` |
| `HOST` / `PORT` | Server listen address (default `127.0.0.1:4141`) |

Example faux command-approval flow:

```sh
YAKITORI_PROVIDER=faux YAKITORI_FAUX_SCENARIO=command pnpm dev
```

Example OpenAI Responses:

```sh
YAKITORI_PROVIDER=openai YAKITORI_MODEL=gpt-5.6 OPENAI_API_KEY=… pnpm dev
```

The model is always explicit so changing provider defaults cannot silently
change the model recorded on a Turn. `gpt-5.6` is an example, not an
application default.

Example Anthropic Messages:

```sh
YAKITORI_PROVIDER=anthropic YAKITORI_MODEL=claude-sonnet-4-20250514 ANTHROPIC_API_KEY=… pnpm dev
```

Never commit API key values. `pnpm test` and `pnpm check` never require network
access or credentials.

### Verify

```sh
pnpm format
pnpm check
pnpm build
```

## Expected Shape

The project will grow around these conceptual areas:

```text
mates      identity, immutable profiles, capabilities, memory policy
collaboration  rooms, tasks, assignments, messages, deliveries, mentions
execution      sessions, inputs, turns, derived items, context, repair
runtime        model loop, scheduling, pending/steer, tool execution
memory         scoped revisions, provenance, retrieval, consolidation
tools          permission-checked built-in and extension capabilities
storage        journals, projections, artifacts, checkpoints
server         versioned local command, query, and subscription APIs
gui            task room and inspectable Mate execution lanes
evals          replay, recovery, collaboration, and memory scenarios
```

These are domain boundaries, not a committed directory layout or a requirement
to split the application into services.

## Architecture Documents

- [Current architecture direction](docs/architecture.md)
- [Initial Session/Turn/Item execution core](docs/decisions/0001-core-shape.md)
- [Kernel v1 boundary](docs/decisions/0002-kernel-prelude.md)
- [Local server API boundary](docs/decisions/0003-server-api-boundary.md)
- [Persistent Mate and Room collaboration](docs/decisions/0004-mate-room-collaboration.md)
- [Transactional SQLite event storage](docs/decisions/0005-sqlite-event-store.md)
- [Collaboration foundations](docs/decisions/0006-collaboration-foundations.md)
- [Kernel as witness](docs/decisions/0007-kernel-as-witness.md)

## Development

Install dependencies:

```sh
pnpm install
```

Run the full local check:

```sh
pnpm check
```

Run the local server and GUI together:

```sh
pnpm dev
```

Open `http://127.0.0.1:5173`. Vite proxies the local session API and event
stream to the server on port `4141`. Use `pnpm dev:gui` or `pnpm dev:server`
when only one side is needed.

Useful individual commands:

```sh
pnpm typecheck
pnpm test
pnpm lint
pnpm format
pnpm build
```

The build keeps the library entry at `dist/index.js` and writes the GUI to
`dist/gui`.

## Agent Instructions

See `AGENTS.md` for repository maintenance rules, style guidance, reference
boundaries, and testing expectations.
