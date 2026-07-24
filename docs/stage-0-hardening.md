# Stage 0: Kernel and Test Hardening

This document specifies four independent work items to complete before any
Room/Delivery or runtime work starts. Each item lists the problem with
evidence, the required fix, and acceptance criteria. Land them in order; each
should pass `pnpm check` independently.

Follow AGENTS.md throughout: minimal diffs, no unrelated refactors, no `any`,
no aliased imports, behavior tests through public APIs, whole-object
assertions where practical.

## Why this, and why now

The project is about to grow from one aggregate (Session) to six
(Room/Task/Assignment/Message/Delivery, plus Mate). Everything in this stage
exists because the cost of these specific defects multiplies with every new
aggregate, while the cost of fixing them stays constant if paid now.

The load-bearing context:

- **Turns will soon have non-user initiators.** A Room Delivery, another
  Mate, or the runtime itself will admit Inputs and drive Turns. Programmatic
  initiators retry mechanically and never hesitate, so correctness of the
  command path (items 1-2) and retry safety stop being hygiene and become
  load-bearing. A duplicate or wrongly-authorized action is no longer a
  cosmetic glitch; it is an unprompted, paid model call and potentially the
  spark of an agent-to-agent wakeup loop.
- **The kernel's guarantees are the product's floor.** The planned
  collaboration layer admits external harnesses as "guest" execution lanes
  with degraded semantics. That only works if the native lane's semantics are
  actually as strong as claimed — the Room layer will be designed assuming
  the kernel keeps its promises. Item 1 is a place where it currently does
  not.
- **Duplicated invariants drift; we already have the proof.** Command-side
  and replay-side validation implement the same rules twice, and the
  permission binding bug is exactly the drift between the two copies. With
  six aggregates, hand-synchronizing twelve copies is not a discipline
  problem, it is a guaranteed-failure mode. One shared transition/guard
  implementation per aggregate is the only version that scales.
- **Tests must anchor on the real storage engine.** The kernel suite
  currently validates correctness against a fake that re-implements pieces of
  the production store. The fake and the store will drift (the mates module
  already shows near-misses maintained by hand), and then the suite is green
  while the real path is broken. Contract tests over both implementations
  make drift mechanically detectable instead of silently eventual.
- **Standards without CI are aspirations.** The repository asks for reviewable,
  verified changes; nothing enforces that today.

Why these four items and not more: this stage deliberately does **not**
generalize idempotency receipts to all commands, add same-transaction read
projections, split durable/transient events, or touch the event schema.
Those are real decisions with real alternatives (per-domain reconciliation vs
a generic receipt table, for one) and each deserves its own ADR in the
Room/runtime stages. Stage 0 is limited to defects whose fix direction is
unambiguous: a security hole, a structural duplication, a test anchor, and
missing enforcement. If you find yourself redesigning something while
implementing this stage, stop — that belongs to a later stage.

## 1. Fix permission-to-tool binding (security)

**Why.** A permission grant is the unit of user trust: the user approves one
specific action, not a blanket capability. Tool execution behind a permission
boundary is a stated project invariant (AGENTS.md), and once Mates can
request tools programmatically, the binding check is the only thing standing
between an approved action and an arbitrary number of unapproved ones. This
is currently broken, and no test catches it.

**Problem.** One permission grant can authorize an unlimited number of tool
calls, including after the permission has been resolved.

`requestTool` binds a permission by calling `requireUnboundPermission`
(src/kernel/session-kernel.ts:789-795), which only checks
`permission.toolCallId === undefined` (src/kernel/session-kernel.ts:1264-1278).
But `applyToolRequested` never writes `permission.toolCallId`
(src/kernel/session-projector.ts:843-862) — only `applyPermissionRequested`
writes it (src/kernel/session-projector.ts:744-759). The binding check
therefore passes for every subsequent tool call, and it never inspects the
permission's resolution state, so a denied or cancelled permission can also be
bound. The error message "already bound to tool" proves one-to-one binding
was the intent.

**Fix.**

- In `applyToolRequested`, when `event.data.permissionRequestId` is present,
  write `toolCallId: event.data.toolCallId` onto the permission projection.
  Replay is deterministic, so existing logs re-project correctly without any
  migration.
- Define and enforce the state semantics of binding: a tool may bind a
  permission only while it is still usable (recommended: state `requested`
  or resolved-allow; reject resolved-deny and ask-cancelled). Encode this in
  the shared guard from item 2 so the command path and replay path cannot
  drift.

**Tests.**

- Exploit test: approve permission P, bind tool T1, start T1, then bind T2
  with the same `permissionRequestId` → must throw `InvalidState`. This test
  must fail on the current code.
- Bind after deny / after ask-cancelled → must throw.
- Replay equivalence: a log containing the binding projects to P bound to T1.

## 2. Merge duplicated command/replay invariants into shared guards

**Why.** Replay is the recovery path: after a restart it is the only thing
that decides what the system believes happened. If command-side and
replay-side validation disagree, either invalid history gets accepted
silently (item 1) or valid history becomes unreadable and bricks a session
forever. Two hand-synchronized copies guarantee both failure modes; the
drift has already produced one security hole. This refactor is also the
template every future aggregate (Room, Delivery, …) will copy, so it
decides whether duplication scales or dies here.

**Problem.** Command validation in session-kernel.ts and replay validation in
session-projector.ts implement the same invariants twice (~400 lines of
near-identical `require*` functions, e.g. `requireAllowedToolPermissions` at
src/kernel/session-kernel.ts:1326-1341 vs src/kernel/session-projector.ts:1156-1175,
`requireNoOpenTurnWork` at 1415-1457 vs 1237-1281). They have already drifted:
item 1 is a product of that drift, and `applyItemUpdated`/`applyItemCompleted`
skip the active-turn check that sibling appliers enforce
(src/kernel/session-projector.ts:706, 719 vs 676, 743).

**Fix.**

- Extract one shared guard module (e.g. src/kernel/session-guards.ts)
  operating on read-only projection views, used by both the command path and
  the replay path. Behavior must stay identical except where item 1 requires
  a change.
- Make the projector's `default` branch throw on unknown event types
  (src/kernel/session-projector.ts:423-424) instead of silently ignoring
  them; forgetting to update the projector must be loud, not lossy.
- Remove the `type PermissionBehavior as PermissionBehaviorValue` aliased
  import (src/kernel/session-projector.ts:13-14); import the value and use
  its inferred type.

**Acceptance.** No invariant logic remains in two copies; the full test suite
passes unchanged apart from the new tests in item 1.

## 3. Test infrastructure

**Why.** The kernel suite is the safety net every later stage leans on, and
it currently proves correctness against a fake rather than the engine that
ships. Fakes that re-implement production logic drift silently — the suite
stays green while the real path breaks, which is worse than having no test
because it manufactures confidence. Contract tests make the two
implementations pin each other down: any drift fails loudly in one of the
two runs. Running the kernel suite on SQLite itself costs a few milliseconds
per test and buys the guarantee that CAS, receipts, and recovery semantics
are exercised where they actually live.

**3a. Stop test fakes from duplicating production logic.**

- test/kernel/memory-event-store.ts (~lines 107-225) re-implements
  `summarizeStoredSession` and `paginateSessionSummaries`, both already
  exported from src/kernel/event-store.ts (:93, :177) and already reused by
  the production SQLite store. Delete the copies and import.
- test/mates/memory-mate-store.ts (~lines 78-104) re-implements the
  limit/cursor validation of src/mates/sqlite-mate-store.ts. Extract a shared
  helper in src and use it in both the production store and the fake.

**3b. Store contract tests.** Extract the store-agnostic cases from
test/kernel/sqlite-event-store.test.ts (append/read/list, pagination,
idempotent receipt, expectedSeq rejection) into a parametrized contract
suite, and run it against both the memory and SQLite implementations. Do the
same for MateStore. A simple loop around `describe` is enough; do not add
runner features.

**3c. Run the session kernel suite against SQLite.** `withKernel`
(test/kernel/session-kernel.test.ts:1231-1242) is hardcoded to the memory
store. Parametrize it so the lifecycle suite also runs against a real SQLite
store in a temp directory. The pattern already exists at
test/mates/sqlite-mate-store.test.ts:22.

**3d. Cover the three untested public commands.** `cancelPermission`,
`failTool`, and `cancelTool` have no direct tests. Add 2-3 cases each: the
success path and the state-machine rejection paths.

**3e. Delete test/kernel/smoke.test.ts** (scaffolding placeholder).

## 4. CI and the slow SSE test

**Why.** Everything in this document is enforced by convention today and by
nothing else; the next stages are specified precisely so that agents and
reviewers can rely on `pnpm check` meaning something. CI is what turns the
project's stated standards into a floor. The 4-second test matters because
a suite that flakes on CI trains everyone to ignore red — the first CI
failure must always be a real failure, or the whole point is lost.

**4a. Add CI.** Create .github/workflows/ci.yml running on pushes to main and
on pull requests: Node 24, pnpm via the `packageManager` field (corepack),
`pnpm install --frozen-lockfile`, then `pnpm check`.

**4b. Fix or bound the 4-second test.** "resumes streams after the latest
query or Last-Event-ID cursor" in test/server/http.test.ts takes ~4s (~84%
of suite time) and sits close to the default 5s testTimeout, so it will
flake on CI. Prefer an event-based wait over fixed sleeps; if a sleep is
unavoidable, set an explicit generous timeout on that test.

## Done when

- `pnpm check` is green with all four items landed.
- The new binding test from item 1 demonstrably fails on the pre-fix code.
- No production `require*` invariant exists in two copies.
- The kernel lifecycle suite passes on both store implementations.
- CI runs and passes on the PR itself.
