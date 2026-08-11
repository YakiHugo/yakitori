# AGENTS.md

## Project

This repository is a from-scratch coding-agent harness and GUI. The primary
goal is a working coding agent — one Mate, one execution lane, solid tools
and persistence. Persistent-memory Mates collaborating in shared task Rooms
are the later product direction — the Raft product's persistent-colleague
collaboration — and only become relevant after the coding agent itself
works. Work in small, reviewable modules and update this file as project
conventions become concrete.

Reference material lives under `.references/` and is intentionally gitignored.
Do not make source code, tests, build scripts, or runtime behavior depend on
files in `.references/`.

local references:

- `.references/public/opencode-v2`
- `.references/public/codex`
- `.references/public/claude-code-sourcemap`
- `.references/public/grok-build`
- `.references/public/opencode` (legacy v1 comparison only)
- `.references/public/pi` (minimal reference only, do
  not mine it for kernel, storage, or collaboration design)
- Public Claude Code documentation and observable product behavior
- Public Raft documentation (product-design reference for the later
  persistent-colleague collaboration direction — Rooms and mentions, not the
  consensus protocol)

## Documentation

- `docs/architecture.md` is the living architecture overview; keep it current
  as boundaries land.
- `docs/kernel-persistence-direction.md` is the settled direction for Session
  kernel persistence: settled principles, storage layout, deferred capabilities
  with triggers, and rejected approaches. Changing it requires an ADR or an
  explicit amendment.
- `docs/decisions/` holds append-only architecture decision records. Never
  rewrite a decision's substance; supersede it with a new numbered record and
  amend the old record's Status section.
- `docs/` root holds only living documents and the one active stage plan.
  When a stage completes, move its plan to `docs/archive/` with an archive
  banner and update inbound links. Archived documents are historical records:
  never implement from them.

## Branch Names

Use a short branch name of at most three words, separated by hyphens. Use
slashes or type prefixes such as `feat/` or `fix/`.

Examples: `feat/session-kernel`, `fix/event-log`, `chore/tool-permissions`.

## Commits and PR Titles

Use conventional commit-style messages and PR titles: `type(scope): summary`.

Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes
are optional; use the affected package or area when helpful.

Examples: `feat(core): add event log`, `docs: update agent instructions`,
`test(runtime): cover session lifecycle`.

## Repository Rules

- Keep `.references/` out of git.
- Keep generated files clearly marked. Do not edit generated output by hand.
- Keep public interfaces narrow and explicit.
- Prefer module-local code until a shared abstraction has more than one real
  caller or names a durable domain concept.
- Avoid broad framework dependencies for the agent loop. Do not use LangGraph,
  AutoGen, OpenAI Agents SDK, Claude Agent SDK, or equivalent orchestration
  frameworks.
- Ordinary engineering libraries are allowed when they do not own the agent
  loop.

## Architecture Boundaries

The coding-agent core comes first. Mate and Room rules are the design
direction for a later stage, not the current priority.

Current stage — the coding agent:

- Treat the harness core as the owner of execution, facts, tools, permissions,
  persistence, memory lifecycle, and repair.
- Treat the existing Session/Input/Turn kernel as one Mate's execution lane.
  Items and Tools are derived views over coarse recorded facts, not separately
  persisted micro-state machines. A Session may have at most one active Turn.
- Keep tool execution behind a permission boundary.
- Keep Session fact persistence append-oriented. Store one flat fact envelope
  per JSONL line; a command may write several lines in one synchronized buffer,
  and recovery retains every complete-line prefix. Advance disposable
  projections only after synchronization, and reconcile admission retries from
  the recorded `input.admitted` fact rather than a generic operation receipt.
- Record tool calls and results, permission requests and decisions, and Turn
  boundaries as structured facts. Keep transient execution state in Runtime
  memory and never fabricate closure facts during recovery.
- Treat the kernel as a witness, not a judge (decision 0007): strict about
  what was recorded, permissive about what it means. Before adding an
  invariant, ask whether the model could see the violation and compensate;
  if yes, record honestly instead.
- Treat the GUI as the only product client of the harness core/server. Runtime,
  schedulers, and adapters are internal modules behind explicit boundaries.
- Projects are registered directories; Sessions carry their own
  workingDirectory and are listed per project; there is one shared Session
  store.
- Be careful with external integration surfaces: local server APIs, persisted
  event formats, configuration loading, and memory deletion.

Later stage — Rooms and multi-Mate collaboration (the Raft product is the
design reference for this stage):

- Keep Mate identity separate from models, processes, runtime leases,
  Sessions, Turns, and subagent handles. Executions must record the immutable
  Mate profile revision they use.
- Keep Room, Task, and Assignment distinct. A Room owns communication and
  visibility, a Task owns the objective and result, and an Assignment binds one
  Mate execution lane to a Task. Different Mates run concurrently in separate
  Sessions.
- Keep a shared Room Message distinct from a Session Input. Store a Message
  once and track per-recipient, idempotent Delivery state for fan-out, catch-up,
  mentions, and wakeup.
- Store authors, recipients, and mentions as stable actor IDs. Display names
  must not be reparsed from message text to decide identity or routing.
- Separate visibility from attention. Ordinary Room messages are available for
  bounded catch-up; a structured mention raises Delivery priority and may wake
  or steer a Mate at a safe boundary.
- Keep detailed reasoning, tool output, and permission facts in the execution
  Session. Only explicitly published findings, questions, results, and artifact
  references enter the shared Room.
- Do not inherit another Mate's personal memory, credentials, permissions,
  or approvals through Room membership, mentions, or Assignments.
- Use stable IDs, idempotent commands, and recoverable saga/outbox behavior for
  operations that cross Room, Delivery, Assignment, and Session boundaries.
- Bound agent-to-agent wakeups. Self-messages, acknowledgements, duplicate
  Deliveries, and exhausted causation budgets must not create model-call loops.
- Treat Delivery scheduling as an external integration surface; apply the same
  care as for the surfaces listed above.

## Style Guide

### General Principles

- Keep things in one function unless logic is reusable, independently named, or
  complex enough that extraction improves the caller.
- Do not extract single-use helpers preemptively.
- Avoid `try`/`catch` where possible. Catch only where error handling is part
  of system management (input admission, tool execution, persistence,
  recovery), and never let an error fail silently — propagate it or record it
  as a fact.
- Avoid `any`.
- Rely on type inference when possible. Add explicit types for exports,
  cross-module contracts, and clarity.
- Keep IDs as plain `string` values. Use clear field names, prefixed ID
  generators, and boundary validation instead of branded ID types.
- Prefer functional array methods such as `map`, `filter`, and `flatMap` when
  they make the code clearer.
- Add comments for non-obvious constraints and surprising behavior, not for
  obvious assignments or control flow.

### GUI Stack

- The GUI (`src/gui/`) is a React 19 + Tailwind v4 + shadcn/ui application.
  The from-scratch rule applies to the agent loop only; the GUI uses ordinary
  frontend libraries.
- The product ships as an Electron desktop app (decisions 0010 and 0014):
  `src/desktop/main.ts` is a thin shell that spawns the server as a sidecar
  child process (`node --watch` in dev, the bundled entry under
  `ELECTRON_RUN_AS_NODE` in prod) and reads the bound URL from the child's
  stdout; in prod the sidecar serves the built GUI same-origin. Electron adds
  no privileged IPC bridge — the HTTP API stays the only GUI↔core channel.
- `src/gui/components/ui/` holds vendored shadcn/ui primitives; treat them as
  generated output — re-vendor or edit locally, never hand-tune their API
  shape ad hoc.
- Keep view projection logic in framework-free modules (`execution-view.ts`)
  with unit tests; React components consume projections, they do not derive
  them.

### Imports

- Avoid aliased imports such as `import { resolve as pathResolve } from "path"`.
- Avoid star imports.
- If a namespace-style value is needed, prefer an explicitly exported namespace
  from the module itself.
- Prefer dynamic imports for heavy modules that are only needed in selected
  code paths.


### Complex Logic

When a function has several validation branches or supporting details, make the
main function read as the happy path and move supporting details into small
helpers below it.

```ts
export function createTurn(input: unknown) {
  const request = requireTurnInput(input)
  const metadata = buildTurnMetadata(request)
  return appendTurn({ request, metadata })
}
```

- Keep helpers close to the code they support.
- Do not over-abstract simple expressions into many single-use helpers.
- Extract only when it names a real concept such as `requireTurnInput` or
  `appendEvent`.

## Model Context And Facts

- Do not rewrite durable history. Build model-visible context incrementally from
  recorded state.
- Everything injected into model-visible context must have a bounded size and a
  hard cap.
- Avoid adding unbounded tool output, file content, logs, or event payloads to
  model-visible context.
- Never inject unbounded Room history. Record the Room sequence or Message
  references selected for each model step.
- Treat long-term memory as scoped, sourced, versioned, revisable, and
  deletable data. A read Message does not automatically become memory.
- Authorize memory collections before retrieval and record the exact revisions
  selected in the ContextSnapshot.
- Keep Mate profile instructions separate from learned memory. Automatic
  extraction cannot silently change profile authority or store secret values.
- Prefer structured facts over ad hoc transcript strings.
- Preserve enough fact data for repair and debugging without forcing every raw
  payload into the model context.

## Testing

Add focused tests with each module.

Priority areas:

- Event ordering and persistence
- Session and turn lifecycle
- Room message ordering and membership history
- Atomic and idempotent Message fan-out
- Per-recipient Delivery, catch-up, mention, and restart recovery behavior
- Parallel Mate Assignments with independent execution Sessions
- Mate profile revision attribution
- Agent-to-agent loop and wakeup budgets
- Memory scope, provenance, visibility, revision, and deletion
- Tool permission decisions
- Tool result recording
- Cached projection consistency with facts rebuilt from the log
- File-change checkpoint behavior

Testing rules:

- Test actual implementation behavior.
- Do not duplicate implementation logic in test assertions.
- Prefer integration-style tests for agent/runtime behavior when practical.
- If unit tests are needed, keep them close to the module under test.
- Prefer comparing whole objects over checking fields one by one when that
  produces clearer failures.

## Change Size

Keep changes small unless they are mechanical.

- Prefer changes under 500 lines for complex logic.
- Avoid changes over 800 lines unless there is a strong reason.
- If a change grows too large, split it into the smallest coherent stage that
  can land independently.

## Commands

Use pnpm for everything. Scripts for format, typecheck, test, check, build,
dev (server, GUI, and desktop), and desktop packaging live in `package.json` —
check the `scripts` section there when you need one instead of guessing.

## UI Changes

When a GUI module exists, changes that affect visible behavior should be checked
in a browser before finalizing. Record the exact verification command or URL in
the final response for the task.

## Reference Comparison

When using reference projects for a design decision, record the comparison in
module notes or code comments only when it affects an implementation boundary.
Do not copy large blocks of code or prose from reference repositories.
