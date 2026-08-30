# AGENTS.md

## Project

This repository is a from-scratch coding-agent harness and GUI. The current
goal is a reliable single-Mate coding agent with solid tools, persistence, and
bounded subagents. Persistent-memory Mates collaborating in shared task Rooms
remain a later product direction and become relevant only after the coding
agent itself works well.

Work in small, reviewable modules. When repeated work establishes a durable
project convention, propose an `AGENTS.md` update; edit this file only when the
user asks for it.

This project is under rapid iteration. Large breaking changes and broad
refactors are reasonable, but keep them reviewable in coherent stages. Do not
add compatibility layers or data migrations unless an explicit requirement
establishes a real compatibility obligation.

## References

Reference material lives under `.references/` and is intentionally gitignored.
Do not make source code, tests, build scripts, or runtime behavior depend on
files in `.references/`.

Reference priority:

- Primary references: `.references/public/codex` and
  `.references/public/grok-build`. Use these first for coding-agent behavior,
  architecture, and implementation decisions.
- Ignore legacy compatibility paths in reference projects unless Yakitori has
  the same explicit historical compatibility obligation. Prefer the current
  clean architecture and product behavior when no such obligation exists.
- Secondary references: `.references/public/opencode-v2`,
  `.references/public/claude-code-sourcemap`, and public Claude Code
  documentation and observable product behavior. Use these only when the
  primary references leave a concrete gap or a comparison would materially
  clarify a decision.
- Do not consult DSH, Gemini CLI, Kimi Code, Manus, Raft, or another reference
  by default. Before using one, propose it and explain why the primary and
  secondary references are insufficient. Raft is relevant only to the later
  persistent-colleague direction of Rooms and mentions

When the primary references agree, or only one implements the relevant
boundary, adopt that established implementation and documented product
direction by default. When they materially differ, present the alternatives,
their concrete differences, and their consequences for Yakitori, then ask the
user to choose. Do not select or synthesize an architecture independently
unless the user has already established the relevant preference.

Once a reference project has been selected for a boundary, align both the
architecture and the concrete implementation design with that project's
current implementation by default. Deviate only when an explicit constraint,
such as multi-provider support or a Yakitori-specific product requirement,
requires it; identify the difference and its reason before implementing it.

Design an independent approach only when an explicit reason makes it better
for Yakitori's scenario. Record that reason in module-local notes or code
comments only when it affects an implementation boundary. Do not copy large
blocks of code or prose from reference repositories.

Unless user has preference，do not take design cues from small personal projects, 
niche frameworks, or unaffiliated industry analysis sites.

Product limits, model capabilities, defaults, and quotas must come from an
explicit requirement or an authoritative first-party source. Locally chosen
resource-safety limits must be named as implementation safety boundaries and
have a concrete rationale; do not present them as product quotas.

## Documentation

- Treat code as the authority for current implementation behavior
- Do not maintain prose that duplicates behavior already expressed clearly by
  public types, focused tests, or code.

## Reviews and Design Work

- When reviewing a change, first separate defects introduced by the current
  change from pre-existing defects. Then identify the root cause as one or more
  of: an architecture-boundary problem, an implementation defect, an incomplete
  migration, or genuinely unused code.
- Explain every non-obvious finding with a concrete trigger scenario or
  maintenance failure mode, its impact, the owning module and adjacent contract,
  and why a local fix is or is not sufficient.
- Before proposing a design, describe the current behavior and place the
  problem within its owning module and adjacent contracts. Define project-local
  or unfamiliar terms in plain language.
- If the user has already adopted a plan and asks for review, evaluate the
  implementation against that plan. 

## Branches, Commits, and PRs

Use a conventional type prefix and a short branch slug of at most three
hyphen-separated words. The prefix does not count toward the three-word limit.

Examples: `feat/session-kernel`, `fix/event-log`, `chore/tool-permissions`.

Use conventional commit-style messages and PR titles: `type(scope): summary`.
Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes
are optional; use the affected package or area when helpful.

Examples: `feat(core): add event log`, `docs: update agent instructions`,
`test(runtime): cover session lifecycle`.

## Repository Rules

- Keep public interfaces and name narrow and explicit.
- Prefer module-local code until a shared abstraction has more than one real
  caller or names a durable domain concept.
- The harness must own its execution and orchestration loop. New runtime
  dependencies require a concrete need and must not take ownership of that
  loop. Do not use LangGraph, AutoGen, OpenAI Agents SDK, Claude Agent SDK, or
  equivalent orchestration frameworks. The GUI may use ordinary frontend
  libraries.

## Style Guide

### General Principles

- Keep logic inline until extraction names a reusable or durable concept, or
  makes multi-branch validation materially clearer. Keep supporting helpers
  close to their caller and make the main function read as the happy path. Do
  not extract single-use helpers merely to shorten a function.
- Catch an error only when it is an expected operational outcome that can be
  translated into the module's established error path, or at a top-level
  boundary to report and clean up before rethrowing or exiting. Do not catch
  unknown errors merely to keep the application running, return a fallback, or
  hide an invariant violation; let unexpected errors fail visibly.
- Avoid `any`.
- Rely on type inference when possible. Add explicit types for exports,
  cross-module contracts, and clarity.
- Do not apply `readonly` mechanically to every object field. Use it when
  immutability is a meaningful exported or cross-module contract; prefer
  ordinary inferred mutable types for local construction and implementation
  details.
- When an object type touched by a change makes every property `readonly`, use
  the `Readonly<T>` utility type instead of repeating `readonly` on each
  property.
- Keep IDs as plain `string` values. Use clear field names, prefixed ID
  generators, and boundary validation instead of branded ID types.
- Prefer functional array methods such as `map`, `filter`, and `flatMap` when
  they make the code clearer.
- Add comments for non-obvious constraints and surprising behavior, not for
  obvious assignments or control flow.

### Imports

- Avoid aliased imports unless they resolve a real name collision or make the
  domain meaning clearer.
- Avoid star imports. If a namespace-style value is needed, prefer an
  explicitly exported namespace from the module itself.
- Prefer dynamic imports for heavy modules used only in selected code paths.

## Testing

Add focused tests when a behavior change creates or changes a durable contract.
Prioritize event ordering and persistence, Session and Turn lifecycle, tool
execution and permission decisions, recovery behavior, cached projection
consistency, and file-change concurrency. Add collaboration and memory tests
when those capabilities have real implementations.

Testing rules:

- Test observable behavior and stable contracts. Derive expected values
  independently of the implementation; never compute an expectation with the
  implementation's own formula or code path.
- Test at the lowest stable boundary that exposes the contract. Use an
  integration test when the contract crosses modules or depends on persistence,
  process, network, Electron, or concurrency behavior.
- Assert an interaction only when that interaction is itself a boundary
  contract, such as preventing duplicate side effects, enforcing a retry
  budget, or issuing a required persistence barrier. Otherwise assert the
  resulting output, durable state, recovery behavior, or external effect.
- A test has no durable value when it would still pass after its claimed
  behavior breaks; only proves that a value can be constructed or a mock returns
  its fixture; mocks away the boundary it claims to cover; exercises an
  unreachable or deleted path; duplicates an existing contract without adding
  a boundary or failure mode; or locks down an internal shape that is not a
  contract. Remove or rewrite such tests.
- The same domain behavior may have unit and integration coverage when they
  protect different boundaries. Do not duplicate the same case at the same
  boundary.
- Add a regression test only when a bug exposes a durable behavior contract, a
  plausible future change could reintroduce it, and existing tests do not
  already protect that contract. When an architectural change makes the old
  failure state unrepresentable, test the new boundary only if its invariant is
  not already enforced by types, structure, or existing tests.
- Name tests after the behavior or invariant they protect, not the incident
  that revealed it.

## Change Size

Keep non-mechanical changes reviewable. Prefer changes under 500 lines of
complex logic, and explain changes over 800 lines. Split larger work at the
smallest coherent ownership boundary that can land independently.

## Commands

Use pnpm for package management and repository scripts. Scripts for format,
typecheck, test, check, build, development, and desktop packaging live in
`package.json`; inspect its `scripts` section instead of guessing commands.

## UI Changes

Verify renderer-only behavior in a browser. Verify Electron bridges, sidecars,
filesystem integration, native dialogs, and desktop lifecycle in the desktop
app. Changes spanning both boundaries must be verified in both. Record the
exact verification command or URL in the final response.
