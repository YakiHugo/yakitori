# 0002: Define the First Kernel Boundary

## Status

Accepted as the kernel v1 implementation plan.

## Context

The first Yakitori kernel should make sessions replayable before it makes an
agent useful. Codex, opencode, and Claude Code all separate durable conversation
state from live runtime behavior, even though they draw the boundary in
different places.

Yakitori should start with the smallest durable core that can later support
model calls, tool execution, permissions, subagents, a local server, and a GUI.

## Goal

Build a kernel that records what happened and can reconstruct the current
session state from recorded facts.

The first implementation should support this lifecycle:

```text
create session
admit input
start turn
append durable events
project state and items
finish, cancel, or fail turn
replay session
```

The kernel does not need to call a model or execute tools yet.

## Core Concepts

### Session

A session is the durable conversation aggregate. It owns event ordering,
pending inputs, turns, items, permissions, tool calls, and replay.

Version one should allow only one active turn per session. Additional user
inputs may be admitted while a turn is active, but they must remain pending
until a later turn promotes them.

### Input

An input is user-authored or system-authored material that has been accepted by
the kernel.

Admission is not the same as model visibility. This keeps room for queued
inputs, interrupts, hidden system prompts, background task notifications, and
future input promotion rules.

### Turn

A turn is one unit of agent work started from one admitted input. It begins
when the kernel promotes an input into work and ends with a completed, failed,
or cancelled state.

The first implementation should treat a turn as a state machine:

```text
pending input -> running turn -> completed | failed | cancelled
```

### Item

An item is a projected, user-facing or model-facing unit inside a turn. Items
are derived from events. They are not the source of truth.

Initial item kinds should stay small:

- `input`
- `assistant_message`
- `reasoning`
- `tool_call`
- `tool_result`
- `permission`
- `error`

### Event

An event is the durable fact written to the append-only log. Events drive all
replay and projections.

Every event should be wrapped in an envelope:

```text
event id
session id
session sequence number
event type
created at timestamp
event data
```

Events may reference a turn, input, item, tool call, permission request, or
parent session when needed.

### Projection

A projection is a read model built by replaying events. It should be cheap to
discard and rebuild.

The first projection should expose:

- session metadata
- pending inputs
- active turn
- completed, failed, and cancelled turns
- items grouped by turn
- tool and permission states
- terminal errors and cancellations

## Initial Event Families

### Session Events

- `session.created`
- `session.metadata_updated`

### Input Events

- `input.admitted`
- `input.promoted`
- `input.cancelled`

### Turn Events

- `turn.started`
- `turn.completed`
- `turn.failed`
- `turn.cancelled`

### Item Events

- `item.appended`
- `item.updated`
- `item.completed`

Streaming deltas should not be required for durable replay in version one.
Later runtime streams can emit live-only deltas and commit bounded final events
when content becomes replayable.

### Permission Events

- `permission.requested`
- `permission.resolved`
- `permission.cancelled`

Permission resolution should include `allow`, `deny`, or `ask_cancelled`
behavior, plus a machine-readable reason when available.

### Tool Events

- `tool.requested`
- `tool.started`
- `tool.progress`
- `tool.completed`
- `tool.failed`
- `tool.cancelled`

The first kernel does not need to run tools, but the event model should be able
to represent tool execution without transcript-only text.

## Command Boundary

Callers should not append arbitrary events directly. The kernel should expose a
small command surface that validates state transitions before writing events:

- `createSession`
- `updateSessionMetadata`
- `listSessions`
- `admitInput`
- `cancelInput`
- `startTurn`
- `appendItem`
- `requestPermission`
- `resolvePermission`
- `requestTool`
- `startTool`
- `completeTool`
- `failTool`
- `completeTurn`
- `failTurn`
- `cancelTurn`
- `readSession`
- `replaySession`

The command layer is where invariants live. The event store only appends and
reads.

## Storage Boundary

Start with local JSONL event files. This keeps persistence visible and easy to
debug.

The storage interface should be narrow enough to replace later:

```text
append(session id, event data) -> event envelope
read(session id) -> event envelopes
list sessions(limit, cursor) -> session summaries, next cursor
```

Each session should have monotonic sequence numbers assigned by the store.
Session listing should return a bounded page so future server and GUI callers do
not depend on unbounded scans or responses.

## Invariants

- Durable history is append-only.
- Session sequence numbers are monotonic and gap-free per session.
- Projection state is rebuilt from events, not mutated as a separate source of
  truth.
- Input admission and turn start are separate events.
- A session has at most one active turn in version one.
- Tool execution, permission decisions, denials, errors, interruptions, and
  cancellations are structured events.
- Provider wire formats are opaque metadata, not core domain types.
- Model-visible context must be built from bounded projections, not raw
  unbounded event payloads.
- Reference repositories under `.references/` must not affect runtime behavior.

## First Implementation Slice

The first kernel slice lives in a small `src/kernel` module:

```text
src/kernel/ids.ts
src/kernel/events.ts
src/kernel/event-store.ts
src/kernel/session-projector.ts
src/kernel/session-kernel.ts
src/kernel/errors.ts
src/kernel/index.ts
```

Focused tests should cover:

- event sequence assignment
- JSONL append and readback
- session listing
- session creation projection
- input admission and promotion
- turn completion and cancellation
- permission and tool state projection
- replay invariants for malformed logs
- invalid state transitions

The project uses Vite and Vitest so it can grow into a GUI without replacing the
test/build foundation.

## Deferred

These are intentionally outside the first kernel slice:

- model provider adapters
- streaming model loop
- shell and file tools
- MCP
- hooks
- subagents
- context compaction
- GUI/server APIs
- cloud worker execution

The event model should leave room for these, but the first implementation should
not build them.
