# 0003: Put a Server API Boundary Before Runtime

## Status

Accepted and implemented as the server API v1 boundary. Decision 0004 extends
it with future Mate collaboration resources. Decision 0005 supersedes only
the initial storage implementation referenced by this decision.

## Current Scope

The existing Session APIs and durable event stream remain execution-lane
interfaces. Mate, Room, Task, Assignment, Message, and Delivery will use
explicit protocol resources rather than being folded into Session responses.

The original separation between durable input admission and runtime wakeup now
also applies across collaboration: posting a Message, creating Deliveries,
admitting a recipient Input, and waking an execution runtime are distinct
operations.

## Context

The kernel v1 boundary now records durable sessions, admitted inputs, turns,
items, permissions, tool state, and replayable projections. That gives Yakitori
enough core state to expose through a local server.

The next tempting step is to build a runtime loop, but the reference projects
show that a stable server/API boundary should come first. opencode keeps public
protocol schemas and server handlers separate from its core session model. It
also distinguishes durable per-session event replay from process-wide live
events. Codex code-mode keeps durable session state separate from execution
runtime concepts such as waiting, terminating, and cancellation.

Yakitori should use those boundaries without copying the reference
implementations.

## Decision

The implementation stage recorded by this decision was the server API boundary
v1, before the model runtime.

The server API should adapt the kernel to narrow public response shapes:

- session creation
- bounded session listing
- session summary or detail reads
- admitted input commands
- durable per-session event streaming
- explicit error responses

The public API must not expose `SessionProjection` as its primary session
resource. Projection remains an internal read model that server handlers can map
into stable protocol objects. This keeps future projection changes from
becoming API-breaking changes.

Session listing should return a bounded page. The event store may continue to
use its internal cursor shape, but HTTP cursors should be opaque and bound to
the original list query, order, and anchor. Callers should not be able to infer
or mix storage cursors directly.

The server should expose a durable session event stream such as:

```text
GET /sessions/:sessionId/events?after=<sequence>
```

This stream replays durable session events after an optional sequence and then
continues with new durable events for that session. It is separate from any
future process-wide live event stream, which should not become a session-filtered
variant of the same endpoint.

Input admission and execution wakeup should stay distinct. A public input or
prompt endpoint may eventually accept a `resume` option, but the server should
not blur durable input admission with runtime ownership before a runtime exists.

HTTP handlers should translate kernel and storage failures into explicit API
errors such as not found, invalid cursor, conflict, and invalid input. Missing
resources should not be represented as empty projections.

## Boundary Shape

The first server slice should stay small:

```text
protocol schemas -> server handlers -> kernel commands/projections
```

The server layer owns:

- request validation
- protocol response shapes
- cursor encoding and decoding
- HTTP status and error mapping
- SSE transport for durable session events

The kernel layer continues to own:

- session command validation
- event sequencing
- durable append and replay
- projection invariants

## Deferred

These were outside the original server API boundary v1:

- model provider adapters
- agent runtime loop
- tool execution process management
- process-wide live event stream
- GUI screens
- indexed session summary storage
- file-backed large tool output storage

The server API should leave room for those modules, especially by keeping
runtime state separate from durable session facts.

## Consequences

Yakitori established a stable local API before adding an agent loop. The
initial GUI now uses that boundary, and the future runtime can connect without
becoming part of the public protocol contract.

Some server responses will duplicate or reshape information already present in
`SessionProjection`. That duplication is intentional: protocol objects are
external contracts, while projections are internal read models.

The initial JSONL event store may still scan session logs for summaries. If
listing becomes expensive, add an explicit summary index rather than changing
the public list contract.
