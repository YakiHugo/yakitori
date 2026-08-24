# AGENTS.md

## Project

This repository is a from-scratch coding-agent harness and GUI. The primary
goal is a working coding agent — one Mate, one execution lane, solid tools,
and persistence. Persistent-memory Mates collaborating in shared task Rooms
are the later product direction and only become relevant after the coding
agent itself works.

Work in small, reviewable modules and update this file as project conventions
become concrete.

This project is under rapid iteration. Large breaking changes and broad
refactors are expected and reasonable; do not add compatibility layers or
data migrations unless an explicit requirement establishes a real
compatibility obligation.

Reference material lives under `.references/` and is intentionally gitignored.
Do not make source code, tests, build scripts, or runtime behavior depend on
files in `.references/`.

## Documentation

- Treat code and tests as the authoritative description of implementation.
  Do not maintain prose that duplicates behavior already expressed clearly by
  public types, tests, or code.
- `docs/` holds only living documents and the one active stage plan. When a
  stage completes, move any surviving decision or non-obvious contract beside
  its owning module, then delete the plan. Git history preserves completed
  plans; do not maintain an in-tree documentation archive.
- Keep a non-obvious subsystem contract beside the module that owns it through
  public types, focused tests, and necessary code comments. Do not create a
  repository-wide architecture document merely to duplicate them.
- Treat commands and configuration as owned by their corresponding source
  files. For example, use `package.json` for scripts instead of prose copies.

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

- Keep generated files clearly marked. Do not edit generated output by hand.
- Keep public interfaces narrow and explicit.
- Prefer module-local code until a shared abstraction has more than one real
  caller or names a durable domain concept.
- Build the harness from scratch. Do not introduce external library
  dependencies into the harness unless explicitly requested. The GUI is the
  standing exception and may use ordinary frontend libraries.
- Do not use LangGraph, AutoGen, OpenAI Agents SDK, Claude Agent SDK, or
  equivalent orchestration frameworks.

## Style Guide

### General Principles

- Keep things in one function unless logic is reusable, independently named,
  or complex enough that extraction improves the caller.
- Do not extract single-use helpers preemptively.
- Avoid `try`/`catch` where possible. Catch only where error handling is part
  of system management, and never let an error fail silently — propagate it or
  record it through the module's established error path.
- Avoid `any`.
- Rely on type inference when possible. Add explicit types for exports,
  cross-module contracts, and clarity.
- Keep IDs as plain `string` values. Use clear field names, prefixed ID
  generators, and boundary validation instead of branded ID types.
- Prefer functional array methods such as `map`, `filter`, and `flatMap` when
  they make the code clearer.
- Add comments for non-obvious constraints and surprising behavior, not for
  obvious assignments or control flow.

### Imports

- Avoid aliased imports such as `import { resolve as pathResolve } from "path"`.
- Avoid star imports.
- If a namespace-style value is needed, prefer an explicitly exported
  namespace from the module itself.
- Prefer dynamic imports for heavy modules used only in selected code paths.

### Complex Logic

When a function has several validation branches or supporting details, make
the main function read as the happy path and move supporting details into
small helpers below it.

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

## Testing

Add focused tests with each module.

Prioritize event ordering and persistence, Session and Turn lifecycle, tool
execution and permission decisions, recovery behavior, cached projection
consistency, and file-change concurrency. Add collaboration and memory tests
when those capabilities have real implementations.

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
development, and desktop packaging live in `package.json`; check its scripts
section instead of guessing.

## UI Changes

When a GUI module exists, changes that affect visible behavior must be checked
in a browser before finalizing. Record the exact verification command or URL
in the final response for the task.

## Reference Comparison

Start comparisons with `.references/public/codex` and
`.references/public/grok-build`; treat their implementations and product
direction as the baseline. Use `.references/public/opencode-v2`,
`.references/public/claude-code-sourcemap`, and public Claude Code behavior
only to fill a concrete gap or materially clarify a decision.

Other references, including DSH, Gemini CLI, Kimi Code, Manus, and Raft, are
opt-in. Propose the additional reference and explain why the primary and
secondary sources are insufficient before consulting it. Raft is relevant
only to the later Rooms-and-mentions direction, not its consensus protocol.

Do not take design cues from small personal projects, niche frameworks, or
unaffiliated "industry analysis" sites — their design docs describe their own
opinions, not validated practice.

By default, adopt the reference implementation and its planned direction.
Design an independent approach only for an explicit project-specific reason,
and record that reason beside the owning module when it affects an
implementation boundary. Do not copy large blocks of code or prose from
reference repositories.
