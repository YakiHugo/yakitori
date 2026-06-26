# AGENTS.md

## Project

This repository is a from-scratch coding-agent harness. Work in small,
reviewable modules and update this file as project conventions become concrete.

Reference material lives under `.references/` and is intentionally gitignored.
Do not make source code, tests, build scripts, or runtime behavior depend on
files in `.references/`.

Allowed local references:

- `.references/public/opencode`
- `.references/public/codex`
- Public Claude Code documentation and observable product behavior

## Branch Names

Use a short branch name of at most three words, separated by hyphens. use
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

- Treat the harness core as the owner of sessions, turns, events, tools,
  permissions, persistence, and replay.
- GUI as the only clients of the harness core/server.
- Keep event persistence append-oriented unless a module documents a stronger
  reason to mutate state.
- Represent tool execution, approvals, interruptions, denials, errors, and
  cancellations as structured state or events rather than transcript-only text.
- Keep tool execution behind a permission boundary.
- Be careful with external integration surfaces:  local server
  APIs, persisted event formats, configuration loading, and session replay.

## Style Guide

### General Principles

- Keep things in one function unless logic is reusable, independently named, or
  complex enough that extraction improves the caller.
- Do not extract single-use helpers preemptively.
- Avoid `try`/`catch` where possible.
- Avoid `any`.
- Rely on type inference when possible. Add explicit types for exports,
  cross-module contracts, and clarity.
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

## Model Context And Events

- Do not rewrite durable history. Build model-visible context incrementally from
  recorded state.
- Everything injected into model-visible context must have a bounded size and a
  hard cap.
- Avoid adding unbounded tool output, file content, logs, or event payloads to
  model-visible context.
- Prefer structured events over ad hoc transcript strings.
- Preserve enough event data for replay and debugging without forcing every raw
  payload into the model context.

## Testing

Add focused tests with each module once a test runner exists.

Priority areas:

- Event ordering and persistence
- Session and turn lifecycle
- Tool permission decisions
- Tool result recording
- Replay behavior
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

The project has not chosen its package manager, runtime layout, or test runner
yet. When those decisions are made, replace this section with exact commands.

Expected future command sections:

- Install
- Format
- Typecheck
- Test
- Run server
- Run GUI

## UI Changes

When a GUI module exists, changes that affect visible behavior should be checked
in a browser before finalizing. Record the exact verification command or URL in
the final response for the task.

## Reference Comparison

When using reference projects for a design decision, record the comparison in
module notes or code comments only when it affects an implementation boundary.
Do not copy large blocks of code or prose from reference repositories.
