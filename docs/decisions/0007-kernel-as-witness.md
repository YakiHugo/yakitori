# 0007: Kernel as Witness — Coarse Facts, Write-Through Projection, Honest Interruption

## Status

Implemented on 2026-07-24. Decision 0002 remains in force except where this
decision explicitly narrows it. Decisions 0005 and 0006 are unaffected except
as noted.

This decision supersedes three parts of decision 0002:

- replay as the way the system determines what happened;
- the Item and Tool micro state machines as separately persisted entities;
- the turn state machine's terminal set and closure requirements.

## Context

The kernel v1 boundary (0002) made sessions replayable before making the agent
useful, and stage 0 hardened that into a strict design: command-side and
replay-side guards validating the same invariants twice, replay as the only
path that reconstructs truth, and terminal commands that fabricate closure
events for anything still open.

Three findings motivate revisiting that posture.

**The reference record does not support replay-derived truth.** Codex
persists model-context-shaped items and normalizes dirty history at read
time; pi persists a message tree; Claude Code repairs transcript DAG orphans
at load. None derive runtime state by replaying a validated event log.
opencode v2 does have a durable event log, but its correctness anchor is that
events and projections commit in one SQLite transaction — startup never
replays, and recovery sweeps interrupted tools lazily on the next drain.

**Dual-path validation already produced a real bug.** Stage 0's permission
binding hole (one approval silently authorizing unlimited tool calls) came
from command-side and replay-side guard copies drifting apart. Validating
the same invariant in two places is a structural cost, not a safety margin:
the data being re-validated at read time was validated when we wrote it.

**The primary consumer of lane history reasons.** The model reads imperfect
history and compensates; what it cannot compensate for is false history.
Strictness that forces the runtime to write claims it does not know to be
true ("this tool was cancelled" when the process simply died) actively
degrades the model's ability to self-verify. The durable record's job is to
be truthful, not to be tidy.

## Decision

### 1. The kernel is a witness, not a judge

The kernel is strict about *what it saw* and permissive about *what it
means*. Every invariant must pass this test: if it were violated, could the
model see the violation and compensate? If yes, the invariant is deleted and
the kernel records honestly instead. If no — the effect already happened in
the real world, or the state is invisible to the model — the invariant
stays.

Invariants that stay, unchanged:

- idempotent input admission with operation receipts and fingerprints;
- compare-and-append (`expectedSeq`) and per-session command serialization;
- at most one active Turn per Session;
- one resolved-allow Permission authorizes exactly one tool call;
- append-only history with monotonic, gap-free sequence numbers;
- strict validation of event payloads at write time.

### 2. An event is admitted to the vocabulary only if it is a fact

A fact is something that really happened and cannot be re-derived from other
facts. Micro state machine transitions that carry no information beyond
"the machine moved" are runtime state that leaked into the log, and are
removed. The vocabulary shrinks from 21 event types to 13:

- `session.created`
- `input.admitted`, `input.cancelled`
- `turn.started`, `turn.completed`, `turn.failed`, `turn.cancelled`,
  `turn.interrupted` (new)
- `assistant.message` (a completed message, including reasoning content
  blocks; streaming deltas remain live-only as before)
- `tool.call`, `tool.result` (a result references its call)
- `permission.requested`, `permission.resolved`

Removed: `session.metadata_updated`, `input.promoted` (folded into
`turn.started`), the entire `item.*` family,
`tool.requested/started/progress/completed/failed/cancelled`, and
`permission.cancelled`.

Item and Tool cease to be separately persisted entities. A projection may
still expose items to consumers, but they are derived from
`assistant.message` / `tool.call` / `tool.result`, not a fact source. A
`tool.call` with no `tool.result` is a legal, honest state: it means "this
was in flight when the record stops."

### 3. Projection is a cache; events are the facts

The event store gains a projection table (one JSON blob per Session to
start; relational decomposition waits for real Room/Delivery queries).
Every append transaction validates, writes events, applies them to the
projection row, and writes the operation receipt in one commit — the
opencode v2 `commitDurableEvent` shape.

`readSession` becomes a plain SELECT. `replaySession` is demoted to a
debugging and repair tool that rebuilds a projection from events; it is no
longer how the system determines what happened. Data flows one way —
facts to derived views — never back. A projection can be deleted and
rebuilt at any time; it is never patched by hand and never treated as a
source of truth.

`turn.completed` may record the input and output token usage accumulated
across that Turn's model calls. The Session projection sums recorded
completed-Turn usage for future context compaction and per-Mate budgeting;
older facts without usage remain valid.

**Three layers of authority.** "Events are the facts" applies only to what
has already happened. The full picture is:

- **In-flight state — memory is authoritative.** Streaming deltas, a
  tool mid-execution, a permission awaiting an answer, runner fibers and
  abort handles: these live in the runtime's memory and are never
  persisted. For "what is happening right now," the runtime is the
  authority and the log is deliberately behind.
- **Recorded facts — the event log is authoritative.** Once something has
  happened (a person spoke, the model spoke, a tool returned, a
  permission was decided, a turn reached a boundary), the event log is
  the only durable witness. Everything derived from it can be rebuilt;
  it can be rebuilt from nothing.
- **Everything else is a consumer.** Projections, SSE catch-up feeds, and
  model-visible context all read from the two authorities above. The SSE
  feed needs no separate outbox infrastructure precisely because it
  consumes the authoritative log directly; demoting it to an
  informational side-stream would reintroduce the two-copy drift problem
  this decision exists to eliminate.

### 4. Validation happens once, at write time

The `InvalidReplay` error channel and all replay-side guards are deleted.
The projector becomes a pure apply function that assumes events are valid
(because the write path validated them) and skips what it does not
understand. Unknown event types are preserved opaquely and never throw:
when models and providers evolve new content kinds, old code degrades
instead of refusing to read history. Sequence continuity is a write-time
guarantee of the single-writer-plus-CAS protocol, not something readers
re-assert.

### 5. Interruption is honest information, not failure

`turn.interrupted` joins the terminal set with a distinct meaning: "the
process stopped here; no claim is made about the work." It differs from
`failed` (the work itself errored) and `cancelled` (a person or agent
deliberately stopped it).

Recovery appends at most one `turn.interrupted` per stranded active turn,
idempotently, and nothing else. It no longer fabricates closure events for
open tools, pending permissions, or in-progress items. "We don't know" is a
first-class representable outcome.

Synthesis belongs to the presentation layer, never the log. When the
model-context builder or the GUI encounters a result-less `tool.call`, it
may annotate the view ("interrupted before result"); it must not write that
annotation back as a fact.

### 5.1 Model-visible semantics are a separate protocol

Kernel event names are not model language. The model-context builder compiles
recorded facts into a bounded, provider-neutral sequence of user messages,
assistant messages, tool calls, tool outcomes, and context notices. Provider
adapters then encode that sequence into their native wire formats. Neither
layer may reinterpret a missing fact as a durable fact.

All recorded Turns whose user input is relevant to the selected history may
enter model context, including `failed`, `cancelled`, and `interrupted` Turns.
Their completed assistant messages and tool results remain visible. A terminal
Turn may add a short context notice that distinguishes:

- `failed`: the execution ended because a known operation errored;
- `cancelled`: a person or agent deliberately stopped the Turn;
- `interrupted`: the Runtime stopped without observing a clean execution
  boundary, so side effects of open work may be unknown.

When a selected `tool.call` has no `tool.result`, the model-context builder
must synthesize a prompt-only tool outcome immediately after that call so the
provider request remains structurally valid. The outcome must say that no
result was recorded, preserve uncertainty about possible side effects, and
recommend inspecting current state before retrying. Its identity and wording
must be deterministic. It is never appended to the event log or projection.

Model-visible failures must describe what the model can do next. In
particular, permission denial means the tool did not run, permission expiry is
not a user denial, and an interrupted tool is not equivalent to a failed tool.
Provider-specific metadata may be replayed only where its original provider
contract remains valid; otherwise it is omitted or degraded to ordinary
content.

### 6. Turns may end with open work

`completeTurn` no longer requires all work to be closed, and terminal
commands no longer batch-fabricate closures. A turn ending says only "the
model considers this round of work said." Open work left behind is recorded
as-is. This keeps the door open for background tasks, which are a feature
of modern agents, not a bug to be invariant'd away.

### 7. Format evolution policy

Following decision 0005's precedent, existing development databases are
discarded, not migrated. From this decision onward, the event format
evolves by tolerant readers and the envelope version field, not by
migration code.

### 8. Recovery has three independently composable layers

Recovery is not synonymous with resuming execution:

- **History reconciliation** records the smallest honest durable boundary for
  execution that disappeared. For Stage 1 this means appending one idempotent
  `turn.interrupted` for each stranded active Turn and nothing else.
- **State discovery** reads the reconciled projection and reports resumable or
  stale work, such as pending Inputs and permissions. It does not start work.
- **Execution scheduling** decides whether and when to wake a Session. Startup
  may request a wake, but it must not await the Session lane draining before
  the server begins listening.

Callers may compose these layers for startup, an explicit repair command, or a
future resume workflow. Each layer remains useful and testable on its own.

## Landing Plan

Three independently landable steps, each leaving `pnpm check` green:

1. **Write-through projection.** Add the projection table, update it in the
   append transaction, switch `readSession` to read it. Zero semantic
   change; the existing test suite must pass without touching an assertion.
2. **Honesty pass.** Delete `InvalidReplay` and replay-side guards, slim
   the projector to pure apply, add `turn.interrupted`, remove fabricated
   closures and the no-open-work requirement, trim the malformed-log suite,
   and add the core invariant test: write-through projection equals
   replay-rebuilt projection for the same event stream.
3. **Vocabulary collapse.** Replace the item and tool families with
   `assistant.message` / `tool.call` / `tool.result`, shrink the command
   surface, and rewrite lifecycle tests. Split mid-way if the change
   approaches the repository's size guidance.

The landing also included the smallest consumer adaptation needed to make the
new record honest end to end: recovery writes `turn.interrupted`, model context
synthesizes a view-only result for an open tool call, and the GUI renders
interruption distinctly while ignoring unknown facts. Resume-able approvals
and richer presentation remain follow-up work.

## Consequences

- The kernel has 13 event types, one copy of each guard, and one fewer error
  class; Item and Tool remain useful projection concepts without owning
  persisted state machines.
- The dual-path guard drift bug class is eliminated by construction.
- History may contain incomplete states (result-less tool calls,
  never-answered permissions). Every consumer of lane history must
  tolerate them; in exchange, no consumer ever reads a fabricated claim.
- A pending permission can now survive a server restart, enabling
  resume-able approvals later; this decision records the possibility but
  does not build it.
- The GUI must render `interrupted` distinctly from `failed` and tolerate
  unknown protocol shapes — the same leniency the kernel adopts internally.
- Retrofitting structure later (e.g. Room/Delivery queries needing
  relational projections) starts from an honest raw event stream, which is
  the best possible substrate; nothing in this decision pre-aggregates
  information away.
