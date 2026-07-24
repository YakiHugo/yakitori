# 0006: Collaboration Foundations — Lane Contract, Attribution, and Consistency Strategy

## Status

Accepted as direction. Implementation is deferred until the MVP runtime
(docs/stage-1-mvp.md) provides real consumers for these contracts; individual
items land when their callers land, starting from what the MVP teaches.

This decision extends decisions 0004 and 0005. It prepares the kernel and
storage layers for the Room/Delivery stage and for execution lanes that are
not the native kernel, without changing the Session aggregate's boundaries.

## Context

Three forces shape the next stages:

- **Turns will have non-user initiators.** A Room Delivery, another Mate, or
  the runtime itself will admit Inputs and drive Turns. Programmatic
  initiators retry mechanically, so attribution, idempotent admission, and
  causation tracking become load-bearing rather than hygienic.
- **Not every execution lane will be the native kernel.** External harnesses
  (e.g. a vendor CLI) should be able to join a Room as a "guest" lane with
  degraded semantics. The collaboration layer must therefore not depend on
  kernel-specific capabilities.
- **The reference record is now clear.** Codex ships no admission idempotency
  and has duplicate-message issues open; opencode moved from a retained
  receipt ledger to per-domain reconciliation against durable events and
  projections; grok-build persists security assumptions with the session and
  documents the WAL-on-network-filesystem hazard. These are proven points to
  borrow, not to reinvent.

The current codebase has the scaffolding but not the wiring: `ActorRef`
(src/actors.ts) has no consumers, `InputAdmitted` carries only a coarse
`role`, `session.created` has no Mate attribution hook, both SQLite stores
independently default to the same file path, only `admitInput` uses the
receipt facility, and the two modules disagree on schema evolution posture
(kernel reads tolerantly, mates reads strictly).

## Decision

### 1. An explicit execution lane contract

The collaboration layer talks to execution lanes only through a narrow
contract, never through kernel internals.

Minimum obligations (the floor, defined by what a guest lane can do):

- **admit**: accept one Input together with an externally supplied stable
  idempotency key. The lane should make retries safe; the collaboration
  layer must not rely on it (see below).
- **event stream**: emit an ordered event sequence per lane. Guests may
  degrade to a minimal translation (turn started → content → terminal).
- **turn terminal states**: report completed/failed/cancelled with a reason.

Declared capabilities (the ceiling, absent in guests): safe-boundary steer,
cancellation, permission surfacing, replay. Lanes declare which they
support; Room behavior degrades accordingly (e.g. a Delivery for a
non-steerable lane waits for the next turn boundary).

The contract must not assume that a lane runs in-process, that lane events
are durable, or that a lane deduplicates admission natively. Consequently,
**at-most-once delivery, causation budgets, and deduplication are owned by
the collaboration layer**; lane-level idempotency is defense in depth, not
the mechanism.

Idempotency key derivation rule: every initiator derives admission keys from
its own durable identity — a Room uses the Delivery ID, the runtime uses the
tool call ID, a user action uses a request ID.

The native kernel already satisfies the floor almost exactly; the contract
ships with a thin adapter proving so.

### 2. Inputs carry their initiator

`InputAdmitted` gains an optional `initiator: ActorRef` (stable actor id and
kind, per the existing src/actors.ts). Display names remain presentation
data and are never reparsed for routing.

The mapping from a Delivery to the Input it produced lives in the
collaboration layer's own state, not in the Input payload; the Input carries
`initiator` and the existing `parentInputId` causation chain, and content
stays `TextContent` for now.

### 3. Sessions record their Mate attribution

`session.created` gains optional `mateId` and `mateRevisionId`, satisfying
the standing rule that executions record the immutable Mate profile revision
they use. The fields are optional now (unassigned Sessions remain legal)
and required for Assignment-created Sessions once Assignments exist.

Per-turn execution-environment snapshots (a TurnContext analogue: cwd,
sandbox, approval policy) are a runtime-stage follow-up; this decision only
fixes the attribution hook.

### 4. Mate identity root vs revisioned profile

Name and role stay in `MateRevision`. The identity root keeps only id,
lifecycle, current revision, and creation time. Rationale: role shapes model
behavior and must be pinned by execution attribution; a rename is an
identity event worth an audit trail; revisions are append-only rows and
cheap. docs/architecture.md is amended to match (it currently lists name and
role as stable identity data).

### 5. Explicit storage ownership, outbox for cross-aggregate consistency

- Both SQLite stores lose their built-in default paths
  (src/kernel/sqlite-event-store.ts:55, src/mates/sqlite-mate-store.ts:50
  currently default to the same `.yakitori/events.sqlite` by coincidence).
  Connections/paths are created and injected explicitly by the composition
  root. One database file remains the deployment shape.
- Cross-aggregate operations (posting a Message plus creating Deliveries;
  claiming a Delivery plus admitting an Input) use an outbox: the source
  aggregate's append transaction also writes an outbox row; a relay performs
  the downstream write idempotently and records progress. At-least-once
  relay plus idempotent consumers gives effectively-once semantics, matching
  the saga/outbox rule in AGENTS.md.
- Shared-transaction machinery across aggregates is not built until a
  concrete case demands it.
- Note for later: WAL is unsafe on network filesystems (mmap'd `-shm`);
  journal mode selection by filesystem type is deferred but recorded.

### 6. A hybrid idempotency rule

Two proven mechanisms exist, and each is applied where it fits:

- **Generic receipt** (the existing operations table + fingerprint) for
  commands without a natural consume point. All mutating Session kernel
  commands gain an optional client operation id; a retry returns the
  original event range. Multi-event commands (`startTurn`, `cancelTurn`)
  benefit most.
- **Per-domain reconciliation** (opencode's proven pattern) for entities
  with a natural stable id and a consume transaction — Room Messages and
  Deliveries. No receipt table is built for them; retries reconcile against
  the durable event and the projection.

Mate commands get receipt support when the shared journal infrastructure
lands in the Room stage; until then the server must not expose Mate writes.

### 7. Strict on write, tolerant on read

Event schemas unify on one evolution posture:

- Write side stays strict (callers cannot smuggle fields; the mates
  `requireMateEvent`/`hasExactKeys` protection is correct for writes).
- Read side becomes tolerant everywhere (required fields validated, unknown
  fields ignored, optional fields optional) — the kernel's current posture,
  extended to mates. Append-only logs outlive the code that wrote them;
  exact-key reading makes every additive change a breaking one.
- `envelope.version` gains minimal real semantics: readers accept version 1
  and reject unknown versions; a breaking change must ship an upcaster
  before version 2 is ever written.
- Unknown event types are preserved opaquely and skipped by projection and
  replay, as superseded by decision 0007 §4. The write side remains strict;
  tolerant reads keep older binaries able to inspect additive or
  provider-specific history without inventing meaning for it.

## Consequences

- The collaboration layer can be designed against one narrow interface, and
  a guest CLI lane becomes possible without kernel changes.
- Every execution can be attributed to an actor and, once Assignments exist,
  to an immutable Mate revision. Older logs stay replayable: all event
  additions are optional fields and the kernel's read path is tolerant.
- Cross-aggregate consistency is honestly eventual: cheap where it lives,
  explicit where it matters. The outbox and any shared-transaction machinery
  arrive with the Room stage, not before.
- The idempotency story becomes uniform for kernel commands without
  committing Room/Delivery aggregates to a receipt table they do not need.
- The receipt table grows unboundedly for now; pruning rides with future
  session deletion and is acceptable for a local tool.
- Mate writes stay unexposed over the server until their idempotency story
  lands, which constrains the order of server work in the Room stage.
