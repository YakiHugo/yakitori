# Yakitori

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-CN.md">简体中文</a>
</p>

Yakitori is a from-scratch learning project for building a local coding-agent
harness and GUI. Its product direction is a coding workbench centered on
persistent-memory `Workmate`s that can work alone or collaborate in a shared
task room.

The goal is to understand the runtime and product boundaries behind modern
coding agents by implementing them directly, one reviewable module at a time.
Yakitori learns from public references but does not wrap or depend on an
existing agent framework.

## Goals

- Build a local coding-agent harness from first principles.
- Give each Workmate a durable identity, versioned profile, governed memory,
  and inspectable history across tasks.
- Let several Workmates work on the same Task concurrently, publish findings to
  one Room, and use structured mentions to request attention.
- Keep shared Messages distinct from per-recipient Deliveries and from each
  Workmate's private execution Session.
- Keep the core responsible for structured execution, collaboration, tools,
  permissions, persistence, recovery, and replay.
- Build a GUI task workbench for shared discussion, Workmate activity, terminal,
  diff, approvals, artifacts, worktrees, and memory provenance.
- Record enough structured state to support debugging, replay, and evaluation.
- Keep each module small enough to understand and replace.

## Product Direction

The target shape is:

```text
Codex-style coding task workbench
+ persistent Workmates and governed memory
+ shared Room collaboration and structured @mentions
+ one inspectable execution lane per Workmate Assignment
```

A Room is not a copy of Slack or Raft's full product shell. It is the shared
communication boundary inside the coding workbench. A Room Message is stored
once; durable Deliveries decide which Workmates should catch up, wake, or steer.
Detailed tool output stays in each Workmate's execution Session unless the
Workmate explicitly publishes a bounded finding or artifact reference.

## Non-goals

- Do not use LangGraph, AutoGen, OpenAI Agents SDK, Claude Agent SDK, or similar
  orchestration frameworks.
- Do not make runtime code depend on local reference repositories.
- Do not clone product behavior wholesale. Reference projects are used for
  comparison and learning.
- Do not treat a Workmate as a permanently running process or silently promote
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

The current implementation includes:

- a replayable Session/Input/Turn/Item event kernel
- structured tool and permission lifecycle facts
- a SQLite event store with ordered append and idempotent operations
- a local HTTP/SSE API boundary
- an initial GUI session workspace

The Session kernel is now scoped as one Workmate's execution lane. Persistent
Workmate identity, Room/Task/Assignment collaboration, durable Message delivery,
the model/tool runtime, and governed memory are accepted architecture direction
but are not implemented yet.

## Expected Shape

The project will grow around these conceptual areas:

```text
workmates      identity, immutable profiles, capabilities, memory policy
collaboration  rooms, tasks, assignments, messages, deliveries, mentions
execution      sessions, inputs, turns, items, context, replay
runtime        model loop, scheduling, pending/steer, tool execution
memory         scoped revisions, provenance, retrieval, consolidation
tools          permission-checked built-in and extension capabilities
storage        journals, projections, artifacts, checkpoints
server         versioned local command, query, and subscription APIs
gui            task room and inspectable Workmate execution lanes
evals          replay, recovery, collaboration, and memory scenarios
```

These are domain boundaries, not a committed directory layout or a requirement
to split the application into services.

## Architecture Documents

- [Current architecture direction](docs/architecture.md)
- [Initial Session/Turn/Item execution core](docs/decisions/0001-core-shape.md)
- [Kernel v1 boundary](docs/decisions/0002-kernel-prelude.md)
- [Local server API boundary](docs/decisions/0003-server-api-boundary.md)
- [Persistent Workmate and Room collaboration](docs/decisions/0004-workmate-room-collaboration.md)
- [Transactional SQLite event storage](docs/decisions/0005-sqlite-event-store.md)

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
