# Architecture Direction

This is the living architecture overview for Yakitori. Architecture decision
records under `docs/decisions/` explain why individual boundaries were chosen.

## Product Target

Yakitori is a local coding-agent workbench built from scratch. Its durable
actors are persistent-memory `Mate`s that can work alone or collaborate in
a shared task room.

The GUI may learn from Codex's task workbench, but Yakitori is not intended to
reuse any reference product wholesale. In particular, collaboration is a
domain capability inside the workbench, not a reason to clone a channel-centric
chat product.

The intended experience is:

```text
Codex-style task workbench
+ persistent Mate identity and memory
+ a shared room for multi-Mate discussion
+ one inspectable execution lane per Mate assignment
```

## Reference Roles

References inform different boundaries rather than defining one inherited
architecture:

- Codex is the primary product and system reference for the workbench, public
  Thread/Turn/Item concepts, local server boundary, terminal, diff, worktree,
  approvals, and agent activity UI.
- OpenCode v2 is the primary reference for durable input admission,
  transaction and recovery semantics, and selected implementation mechanisms.
- Pi is a reference for a small model loop and provider/tool boundaries.
- Claude Code documentation and observable behavior are cross-checks for
  permissions, hooks, instructions, and terminal product behavior.
- Raft is a product-design reference for treating agents as persistent
  colleagues and for room, mention, and collaboration semantics. Yakitori does
  not inherit Raft's information architecture.
- OpenCode v1 is a legacy comparison only.

Runtime code must not depend on any local reference repository.

## Domain Map

```text
Project
|- Mates
|  |- immutable profile revisions
|  `- personal memory collections
|- project and explicitly shared memory collections
|- Rooms
|  |- members
|  |- ordered Messages
|  `- per-recipient Deliveries
`- Tasks
   |- one collaboration Room
   `- Assignments
      `- one Mate execution Session
         `- Inputs -> Turns -> recorded facts -> derived views
```

The first product version may create one Room automatically for each Task. The
entities remain distinct because a Room answers who can communicate and see
messages, while a Task answers what must be completed and what counts as a
result. This also leaves room for one stable group to handle multiple tasks
later without changing the execution model.

### Mate

A `Mate` is a durable identity, not a process, Thread, Session, model, or
subagent handle. It can participate in many Tasks and survive runtime restarts
or provider changes.

The stable identity root contains the Mate ID, lifecycle state, current
profile revision, and creation time. Name, role, instructions, personality,
model policy, and capability policy live in immutable `MateRevision`s. An
execution Session records the exact revision it uses so later profile changes
do not rewrite previous work.

`Subagent` is a relative role in one collaboration, not a separate kind of
durable identity.

### Room, Task, and Assignment

A `Room` is the shared communication and visibility boundary. It owns ordered
Messages, membership history, replies, mentions, and delivery policy.

A `Task` owns a goal, completion policy, status, and results. It is associated
with a Room but does not own an agent's tool transcript.

An `Assignment` associates one Task with one Mate and its execution
Session. Multiple Assignments may intentionally carry the same objective so
several Mates can investigate or implement the same work independently.
Task completion is decided by the user or an authorized coordinator; it is not
necessarily equivalent to every Assignment finishing.

### Execution Session

The current `Session -> Input -> Turn` kernel remains the execution lane for
one Mate assignment. It records coarse facts such as completed assistant
messages, tool calls and results, permission decisions, and honest terminal
boundaries. Item and Tool state exposed to consumers is derived from those
facts rather than persisted as a second micro-state machine. Version one keeps
at most one active Turn per execution Session while different Mates execute
concurrently in different Sessions.

A runtime activation is temporary and owns in-flight state such as streaming,
runner fibers, active tool execution, and abort handles. Process IDs, leases,
sockets, and online state are operational projections, not Mate identity. If a
process stops mid-Turn, recovery records one `turn.interrupted` fact without
inventing results for unfinished work.

## Shared Messages and Durable Delivery

A Room Message and an execution Input are different objects:

- A `Message` is the canonical content visible in the Room. It is stored once
  and has a monotonic room sequence number.
- A `Delivery` records that a particular Mate should notice or act on a
  Message. It has its own durable lifecycle and refers to the Message instead
  of copying its content.
- An execution `Input` is admitted into one Mate's Session when a Delivery
  is scheduled. It can still use the current pending, promotion, and Turn
  lifecycle.

One user request can therefore fan out safely:

```text
one Room Message
-> one Delivery per assigned Mate
-> one Input in each execution Session
-> parallel Turns
```

Room visibility does not imply an immediate model call:

- A user assignment wakes the selected Mates.
- A structured `@mention` creates a high-priority Delivery.
- A reply notifies the original author according to Room policy.
- An ordinary Mate finding is visible to every member and enters a bounded,
  low-priority catch-up path rather than waking the whole Room immediately.
- `@all` is restricted to the user or an authorized coordinator and is rate
  limited.

Mentions store stable Mate IDs. Display names are presentation data and
must not be reparsed from plain text to decide recipients.

If a target Mate is idle, a claimed Delivery may start its next Turn. If it
is busy, the Delivery is queued and injected at a safe model boundary; it must
not interrupt an in-flight tool transaction. Offline Mates retain pending
Deliveries for later recovery.

Detailed reasoning, tool output, and execution events stay in the Mate's
execution Session. A Mate explicitly publishes bounded findings, questions,
results, and artifact references to the Room. Other Mates do not
automatically ingest its private execution transcript, although the user can
inspect that lane in the GUI.

## Persistent Memory

Identity configuration and learned memory are different:

- Profile revisions define who the Mate is instructed to be.
- Working context belongs to an execution Session or Turn.
- Personal memory belongs to one Mate.
- Project memory belongs to a Project.
- Shared memory is an explicitly granted collection; there is no implicit
  global team memory.

Memory is treated as a sourced, revisable claim rather than immutable truth.
Every accepted revision has provenance, scope, author, and lifecycle state.
Automatic extraction produces a `MemoryCandidate` before it can affect durable
memory. Untrusted tool or web content cannot silently rewrite a Mate
profile, and secret values never enter memory.

Retrieval is authorized before search, bounded by hard item/token/byte limits,
and records the exact memory revisions selected for a model step in a
`ContextSnapshot`. Personal memory and permissions do not propagate through an
Assignment or mention unless an explicit grant allows it.

Unlike the append-only execution journal, memory must support correction and
deletion. Immutable event logs may record memory IDs and actions, but should not
retain deletable memory plaintext.

## Persistence and Coordination

Durable facts remain append-oriented and projections remain rebuildable. For
execution Sessions, each append updates the event journal, operation receipt,
and write-through projection in one SQLite transaction. Normal reads select
the projection directly; replay is reserved for debugging and repair. The same
event-journal infrastructure may back multiple aggregates, but Room, Task,
Assignment, and execution Session keep distinct domain contracts.

Operations crossing aggregates use stable IDs, idempotent commands, and a
recoverable saga or outbox. They must not assume that posting a Room Message,
creating several Deliveries, and starting execution Sessions happen in one
in-memory call.

The live event hub accelerates GUI updates; it is not the durable scheduler.
The scheduler claims Delivery state from persistence so mentions and broadcasts
survive process restarts.

## Concurrency and Safety

- Different Mate execution Sessions may run in parallel.
- One Mate and Assignment have at most one active execution attempt by
  default.
- Concurrent code-writing Assignments use isolated worktrees by default. A
  coordinator or explicit integration Assignment combines results.
- A shared live workspace requires checkpointed writes and conflict detection;
  last-writer-wins is not acceptable.
- Permission grants are bounded by user authority, workspace policy, the
  requester's delegable rights, Assignment policy, and the current tool call.
- A Mate does not inherit another Mate's personal memory, credentials,
  or approvals.

Agent-to-agent wakeups also require loop controls:

- each Delivery is consumed at most once
- a Mate's own Message does not wake itself
- acknowledgements do not require a model-generated reply
- causation depth, message, mention, run, token, and time budgets are bounded
- exhausted collaboration enters a visible waiting state instead of continuing
  silently

## GUI Shape

The main surface remains a coding-task workbench rather than a general chat
application. A Task view contains:

- the shared Room conversation
- participating Mates and Assignment status
- pending and mentioned activity
- expandable per-Mate execution lanes
- terminal, diff, approvals, artifacts, and worktree state
- memory citations and memory management where relevant

Permanent channel navigation, social presence, and a general-purpose task board
are not required by this architecture.

## Implementation Direction

The MVP runtime now drives Turns end to end through the witness-style kernel
and write-through SQLite projection, visible in the GUI. Collaboration
contracts can now land against real execution-lane callers. The remaining
architecture-sensitive stages are:

1. Add safe-boundary steer/catch-up behavior and result publication.
2. Add Room, Task, Assignment, Message, and Delivery
   contracts and projections (decision 0006 items land here, with consumers).
3. Associate one execution Session with each Assignment and add a durable
   Delivery scheduler.
4. Add explicit memory CRUD and ContextSnapshot manifests before enabling
   conservative candidate extraction and consolidation.
5. Grow the GUI around the shared Room and inspectable execution lanes.

Embeddings, automatic memory consolidation, long-lived reusable Rooms,
distributed execution, organization-wide sharing, and autonomous Mate
profile modification remain deferred.
