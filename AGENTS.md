# AGENTS.md

## Project

This repository is a from-scratch coding-agent harness and GUI centered on
persistent-memory Mates that can collaborate in shared task Rooms. Work in
small, reviewable modules and update this file as project conventions become
concrete.

Reference material lives under `.references/` and is intentionally gitignored.
Do not make source code, tests, build scripts, or runtime behavior depend on
files in `.references/`.

Allowed local references, in priority order:

- `.references/public/opencode-v2` (primary: architecture — server/API
  boundary, durable input admission, SQLite event log + projections)
- `.references/public/codex` (primary: product workbench shape and context
  management — rollout, compaction, fork, read-side normalization)
- `.references/public/claude-code-sourcemap` (secondary: product behavior
  cross-check; Rooms-stage reference for multi-agent tasks, permission UX,
  and file checkpoints)
- `.references/public/grok-build` (secondary: security model — session-
  persisted security assumptions, WAL-on-network-filesystem hazard; see
  decision 0006)
- `.references/public/opencode` (legacy v1 comparison only)
- `.references/public/pi` (consumed: its StreamFn contract and faux provider
  patterns already landed in `src/runtime/`; historical reference only, do
  not mine it for kernel, storage, or collaboration design)
- Public Claude Code documentation and observable product behavior
- Public Raft documentation (consensus reference for future coordination)

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

- Treat the harness core as the owner of Mates, collaboration, execution,
  facts, tools, permissions, persistence, memory lifecycle, and repair.
- Treat the GUI as the only product client of the harness core/server. Runtime,
  schedulers, and adapters are internal modules behind explicit boundaries.
- Keep Mate identity separate from models, processes, runtime leases,
  Sessions, Turns, and subagent handles. Executions must record the immutable
  Mate profile revision they use.
- Keep Room, Task, and Assignment distinct. A Room owns communication and
  visibility, a Task owns the objective and result, and an Assignment binds one
  Mate execution lane to a Task.
- Treat the existing Session/Input/Turn kernel as one Mate's execution lane.
  Items and Tools are derived views over coarse recorded facts, not separately
  persisted micro-state machines. A Session may have at most one active Turn
  while different Mates run concurrently in separate Sessions.
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
- Keep fact persistence append-oriented and update each Session's write-through
  projection in the same transaction as the facts and operation receipt.
- Record tool calls and results, permission requests and decisions, and Turn
  boundaries as structured facts. Keep transient execution state in Runtime
  memory and never fabricate closure facts during recovery.
- Treat the kernel as a witness, not a judge (decision 0007): strict about
  what was recorded, permissive about what it means. Before adding an
  invariant, ask whether the model could see the violation and compensate;
  if yes, record honestly instead.
- Keep tool execution behind a permission boundary.
- Do not inherit another Mate's personal memory, credentials, permissions,
  or approvals through Room membership, mentions, or Assignments.
- Use stable IDs, idempotent commands, and recoverable saga/outbox behavior for
  operations that cross Room, Delivery, Assignment, and Session boundaries.
- Bound agent-to-agent wakeups. Self-messages, acknowledgements, duplicate
  Deliveries, and exhausted causation budgets must not create model-call loops.
- Be careful with external integration surfaces: local server APIs, persisted
  event formats, configuration loading, Delivery scheduling, and memory
  deletion.

## Style Guide

### General Principles

- Keep things in one function unless logic is reusable, independently named, or
  complex enough that extraction improves the caller.
- Do not extract single-use helpers preemptively.
- Avoid `try`/`catch` where possible.
- Avoid `any`.
- Rely on type inference when possible. Add explicit types for exports,
  cross-module contracts, and clarity.
- Keep IDs as plain `string` values. Use clear field names, prefixed ID
  generators, and boundary validation instead of branded ID types.
- Prefer functional array methods such as `map`, `filter`, and `flatMap` when
  they make the code clearer.
- Add comments for non-obvious constraints and surprising behavior, not for
  obvious assignments or control flow.

Reduce total variable count by inlining values that are only used once.

```ts
// Good
const event = await readJson(path.join(dir, "event.json"))

// Bad
const eventPath = path.join(dir, "event.json")
const event = await readJson(eventPath)
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation when it preserves useful
context.

```ts
// Good
tool.name
tool.input

// Bad
const { name, input } = tool
```

### Imports

- Avoid aliased imports such as `import { resolve as pathResolve } from "path"`.
- Avoid star imports.
- If a namespace-style value is needed, prefer an explicitly exported namespace
  from the module itself.
- Prefer dynamic imports for heavy modules that are only needed in selected
  code paths.

### Variables

Prefer `const` over `let`. Use early returns or expression-level assignment
instead of reassignment.

```ts
// Good
const mode = isReadOnly ? "read" : "write"

// Bad
let mode
if (isReadOnly) mode = "read"
else mode = "write"
```

### Control Flow

Avoid `else` statements when an early return is clearer.

```ts
// Good
function permissionLabel(allowed: boolean) {
  if (allowed) return "allow"
  return "deny"
}

// Bad
function permissionLabel(allowed: boolean) {
  if (allowed) return "allow"
  else return "deny"
}
```

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
- Write-through projection consistency with facts rebuilt from the log
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

## Current Commands

Install:

```sh
pnpm install
```

Format:

```sh
pnpm format
```

Typecheck:

```sh
pnpm typecheck
```

Test:

```sh
pnpm test
```

Check:

```sh
pnpm check
```

Build:

```sh
pnpm build
```

Run the local server and GUI together:

```sh
pnpm dev
```

Run only one development side:

```sh
pnpm dev:gui
pnpm dev:server
```

## UI Changes

When a GUI module exists, changes that affect visible behavior should be checked
in a browser before finalizing. Record the exact verification command or URL in
the final response for the task.

## Reference Comparison

When using reference projects for a design decision, record the comparison in
module notes or code comments only when it affects an implementation boundary.
Do not copy large blocks of code or prose from reference repositories.
