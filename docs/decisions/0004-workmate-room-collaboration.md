# 0004: Separate Workmates, Rooms, and Execution Sessions

## Status

Accepted as the target domain direction for persistent Workmates and
collaboration. Concrete schemas and scheduling policies remain incremental
implementation decisions.

This decision extends decisions 0001 through 0003. It narrows the existing
Session model to one Workmate's execution lane rather than superseding the
implemented kernel or server boundaries.

## Context

Yakitori's product goal is no longer only a single-agent session harness. It is
a coding workbench in which long-lived Workmates retain identity and governed
memory across tasks, and multiple Workmates can collaborate in a shared room.

A user may assign the same objective to several Workmates. Each Workmate should
execute independently, publish useful findings to the room, notice relevant
updates from others, and use structured mentions to request another member's
attention.

The shared discussion and one Workmate's execution history have different
ordering, visibility, permission, and context-building requirements. A single
transcript or Session cannot represent both cleanly. In particular, one shared
message may be consumed by several Workmates, while the existing durable Input
is promoted into one Turn.

## Decision

Yakitori will add a collaboration layer above the existing Session kernel.

The durable domain shape is:

```text
Workmate    long-lived identity, profile revisions, and memory policy
Room        membership and one ordered shared message history
Task        shared objective, completion policy, status, and results
Assignment  one Workmate's responsibility for a Task
Session     one Workmate's durable execution lane for an Assignment
Turn        one unit of work inside an execution Session
Message     content published once to a Room
Delivery    one recipient's attention and processing state for a Message
```

Version one may create exactly one Room for each Task while keeping the
concepts distinct. Several Assignments may intentionally carry the same
objective when independent or redundant work is desired.

### Persistent Workmates

A Workmate is not a model process, provider, Session, prompt string, or runtime
agent handle. Its identity outlives runtime restarts and can participate in
many Tasks and Rooms.

Instructions, personality, model defaults, memory policy, and capability policy
use immutable profile revisions. Each execution Session records the Workmate
and exact profile revision it uses. Changing a provider or profile does not
create a new Workmate or rewrite past work.

`Subagent` remains a relative role within one collaboration rather than a
separate kind of durable identity.

### Rooms, Messages, and Mentions

A Room Message is appended once to the shared Room history. It is not copied
into several independent transcripts as several sources of truth.

Messages are visible to Room members. Delivery state and participant cursors
determine what each Workmate has observed and whether its runtime should be
woken or steered. Retrying a Delivery must not create duplicate work for the
same Message and recipient.

A structured mention changes routing and attention, not visibility. Mentions
store stable Workmate IDs; display names are presentation data. A mention may
start an idle Workmate or queue input at a safe boundary for a busy Workmate,
but it must not interrupt an in-flight tool transaction.

Ordinary Workmate messages enter a bounded, low-priority catch-up path. They do
not immediately wake every participant. This allows members to notice shared
findings without creating an unbounded agent-to-agent feedback loop.

### Existing Sessions as Execution Lanes

The existing `Session -> Input -> Turn -> Item` kernel remains one Workmate's
execution lane. A Session continues to own admitted and pending Inputs, at most
one active Turn, Items, tool calls, permission decisions, cancellation, event
ordering, projection, and replay.

Parallel work uses several execution Sessions rather than several active Turns
inside one Session. A Room coordinates these Sessions but does not own their
tool or permission state.

A claimed Delivery may admit an Input into its recipient Session. The Room
Message and Session Input remain distinct durable facts, and the Input records
its source Message or Delivery reference. Detailed tool output and execution
history stay in the Session; the Workmate explicitly publishes bounded
findings, questions, results, and artifact references back to the Room.

`parentSessionId` remains execution lineage and must not be overloaded to mean
Room membership, Assignment, or Message delivery.

### Persistent Memory

Workmate profile, Room history, Session history, and long-term memory are
separate concepts.

Long-term memory has an explicit scope, provenance, and revision. Initial
scopes are personal Workmate memory, Project memory, and explicitly granted
shared collections. Joining a Room does not grant access to another
Workmate's personal memory, and seeing a Message does not automatically promote
it into long-term memory.

Automatic learning first creates a candidate. Memory policy or the user decides
whether it becomes an accepted revision. Memory is bounded during retrieval and
cannot silently change a Workmate's profile or store secret values.

Each model step records the exact Workmate profile revision, memory revisions,
Room cursor or Message references, and Session boundary used to compile its
context. Raw Room and Session histories are never injected without a hard cap.

Memory supports correction and deletion. Append-only journals may record
memory IDs and actions but should not retain deletable memory plaintext.

## Invariants

- Workmate identity outlives processes, providers, Tasks, Rooms, and Sessions.
- One execution Session belongs to one Workmate Assignment and has at most one
  active Turn.
- Parallel Workmate execution uses separate Sessions.
- A Room has one ordered shared Message history.
- Message visibility is separate from Delivery, wakeup, and mention priority.
- Authors, recipients, and mentions use stable actor identifiers.
- Room Messages and Session Inputs are different durable facts.
- Tools and permissions remain behind each execution lane's permission
  boundary.
- Room membership does not implicitly share credentials, approvals, or
  personal memory.
- Assignments, messages, mentions, deliveries, failures, and cancellations are
  structured facts rather than transcript-only text.
- All model-visible Room, memory, tool, and file content is bounded.
- Agent-to-agent wakeups have idempotency, causation-depth, message, token, and
  time budgets.

## Consequences

The current event store, replay model, Session projector, server boundary, and
single-active-Turn invariant remain useful. Collaboration adds new aggregates
and projections instead of making the existing Session aggregate concurrent.

The GUI can keep a task-workbench shape. A Task view presents one shared Room
and expandable Workmate execution lanes; it does not need to become a
general-purpose channel application or task board.

Operations crossing Room, Delivery, Assignment, and Session boundaries require
stable IDs, idempotent commands, and a recoverable saga or outbox. The live GUI
event stream cannot act as the durable scheduler.

Concurrent code-writing Assignments should use isolated worktrees by default
and publish bounded change or artifact references for integration. Sharing a
Room does not imply unsafe concurrent writes to one workspace.

## Deferred

- exact event families, tables, scheduler claims, retries, and backpressure
- autonomous coordinator selection and task decomposition
- long-lived Rooms containing several concurrent Tasks
- private messages, permanent channels, moderation, and broader social UX
- exact memory extraction, consolidation, ranking, conflict, and forgetting
  policies
- autonomous Workmate profile modification
- shared-live workspace locking and change integration policy
- remote Workmates and distributed execution
- exact GUI labels and layout
