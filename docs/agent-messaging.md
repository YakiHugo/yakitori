# Agent messaging and recovery boundary

The subagent controller coordinates members of one registered root tree. It does not
accept arbitrary historical Session IDs as execution targets. The reference
boundary is Codex's [V2 agent API and message delivery modes](https://github.com/openai/codex/blob/8c0f7011674145da7e10627769fb221c74fbf7a0/codex-rs/core/src/agent/api.rs).
Yakitori keeps its existing Session-owned execution and persistence paths.

## Compatibility and intentional changes

The model-facing `send_message` and `followup_task` names, input schemas, and
success-result fields are unchanged. `BoundAgentControl.followup` adds an
optional stable `messageId`; the tool supplies its call ID. Existing callers
that omit it continue to work, but each invocation is a distinct request.
Queue-only messages retain their existing durable ID format.

A running `followup_task` now uses the recipient Session's atomic steering
boundary. It is consumed by the current Turn at a safe sampling boundary,
including after a pending tool finishes. Previously every follow-up queued a
separate Turn. If the recipient has already stopped accepting steering, the
controller queues a new Turn behind its existing worker. Idle follow-ups also
start a new Turn. Follow-ups retain the recipient's configured model instead
of replacing it with the sender's model; spawn overrides are unchanged.

`wait_agent` can now return `reason: "closed"` when its tree or agent closes.
Path-prefix listing matches whole task-path segments. Interrupting the root or
oneself is rejected. Existing ID, canonical-path, and caller-relative child
addressing remain available; siblings use an ID or canonical path.

The internal runtime adapter now implements `steerChild`, which returns false
when a fresh Turn must be queued. This is an internal adapter contract change,
not a new HTTP/RPC endpoint. No GUI integration, automatic task-dispatch policy,
default provider/model, or admission limits are changed.

## What an acceptance receipt means

- QueueOnly (`send_message`) appends an attributed message to Session history
  and waits for the existing persistence barrier. It does not start an idle
  recipient. Reusing the same sender/call ID deduplicates the stored message,
  including after Session reload.
- TriggerTurn (`followup_task`) acknowledges admission. Accepted steering is
  held by the active Session until the processor records it at a safe boundary;
  a new queued Turn is held by the controller until Session launch. These
  pre-recording states are not a crash-durable task queue.
- Concurrent or subsequent follow-up retries with the same sender/call ID are
  coalesced in a live controller. Once Session input is recorded, its persisted
  receipt also prevents a restart/reload retry from starting another Turn.
  Reusing an ID for different content is an error, not a new task.
- Acceptance does not mean the model read, acted on, or completed the message.
  There is no exactly-once model-consumption or external-side-effect guarantee.
  Callers must inspect outcomes and make consequential effects idempotent.
- Completion delivery uses the existing stable terminal-record ID and retry
  path. Retrying delivery does not rerun the child.

## Waiting and lifecycle

Mailbox wake notifications are separate from the message text in Session
history. An arrival before `wait` subscribes remains observable by its next
successful wait. Cancellation and a deadline that wins the race do not consume
later notifications. These notification bits are process-local; they are not a
persisted unread cursor or evidence of model consumption. Reloaded history
remains the durable message source.

Closing first fences the subtree, wakes its waiters, and settles admitted
message operations before unregistering actors. Old bound controllers cannot
send, spawn, or interrupt through a reused path. Recovery registers and
validates the complete parent chain before replaying completion notifications;
an invalid or outside-tree parent fails recovery without delivering that
result to an unrelated Session.

## Independent sessions

Independent-session collaboration lives in `runtime/thread-collaboration.ts`,
composed once with the service's `ThreadManager` and `ThreadStore`. It does not
use the subagent registry or depend on a GUI connection. This keeps a future
ACP transport at the service boundary rather than in renderer lifecycle code.
Its tool vocabulary follows Codex's
[dynamic thread tools](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/tui/src/dynamic_tools.rs).
Yakitori's multi-provider messages cannot carry an unpaired provider-specific
tool output, so the recipient receives a fixed developer trust wrapper around
a JSON payload with source provenance. Only the wrapper is instruction-bearing;
the body is other-agent data, never owner authorization.

A durable admission receipt, recorded model-context consumption, and a terminal
Turn are distinct facts. Restart recovery exposes incomplete delivery rather
than automatically replaying an unconsumed task. The send request is not a
guarantee of exactly-once model execution or external effects. Result tracking
is request/Turn-specific and never automatically starts a callback Turn in the
source. A caller that wants further work decides explicitly after reading the
result.

There is no second V1/V2 engine or rollout migration. New configurations enable
the current tools by default. The optional collaboration configuration marker
allows a one-time extension of known historical complete default tool lists;
unknown/restricted lists and current explicit overrides remain unchanged. Old
rollout records are not rewritten.

Search reuses the existing visible-conversation index: titles, user input and
final assistant answers. Tool results, reasoning, other-agent messages and raw
runtime events are not searched. Paginated transcript reading exposes recorded
model content, including those messages, but excludes opaque provider replay
state. Its snapshot metadata explicitly reports when newer items are available;
restart reading without a cursor to include them. Raw runtime-event analytics
and cross-machine discovery are separate future boundaries.
