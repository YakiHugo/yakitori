# Code Follow-Ups

Status: living register of recorded code work. Each item lands as its own
small reviewable change or is absorbed into a redesign stage. Recorded from
the 2026-07-30 documentation/code audit; nothing here is started.

## Mate redesign (recorded direction)

All Mate-related code (`src/mates/`, plus the Mate-facing parts of the runner
and server) will be redesigned. Until that redesign lands, avoid growing the
current Mate implementation beyond what the coding-agent stage needs.

Open questions the redesign should answer explicitly:

- Whether the Mate projector stays a strict validator (a "judge": first event
  must be `mate.created`, gap-free sequence, monotonic revisions, no revising
  inactive Mates) while the Session kernel is a witness (decision 0007). The
  divergence is currently undocumented.
- Whether the Mate store keeps the `events.sqlite` fallback introduced by
  decision 0008 ("Existing SQLite Data").

## Dead code deletion candidates

Each can land first as an independent small change:

- `src/actors.ts` and its re-export in `src/index.ts` — no internal caller;
  reintroduce with the collaboration stage that needs it.
- `createToolCallId` in `src/kernel/ids.ts` — never called; tool call IDs
  come from the model response.
- `ItemProjection.metadata` in `src/kernel/session-projector.ts` — declared
  but never assigned.
- `ModelRequest.metadata` / `ModelResponse.metadata` in
  `src/runtime/model.ts` — only the faux provider plumbs them.
- `approvalPolicy` in `TurnExecutionContext` — recorded on `turn.started` but
  never consumed; actual approval behavior is driven by
  `RuntimeTool.autoAllow`. Removing it changes the `turn.started` fact shape
  and requires an explicit envelope-version decision.

## Stale wording in code

- `src/server/handlers.ts` error messages say "in Stage 1" while stage 1 is
  archived (`docs/archive/`). Reword to describe the restriction without
  naming a stage (for example, "in the current single-Mate stage").

## Desktop shell follow-ups (recorded 2026-07-31)

- Packaged builds launched from Finder resolve the default workspace/store
  from `process.cwd()` (which is `/`). Before shipping packaged builds, add a
  workspace picker or a user-data default with an explicit project-open flow
  (decision 0010, Deferred Work).
- Static GUI serving is GET-only (no HEAD); add HEAD if a real client needs
  it.
- `pnpm package:desktop` produces an unsigned `dir` build only; signed
  `dmg`, notarization, and auto-update are unconfigured.
- `dev:desktop` shares port 4141 with `dev:server`; running both at once
  collides on the runtime lock and the port.
