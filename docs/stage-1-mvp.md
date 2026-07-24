# Stage 1: MVP — a Mate That Actually Runs

> Stage 1 is complete. This document records the plan that produced the MVP;
> decision 0007 now controls event vocabulary, projection, and recovery
> semantics where its terminology differs from this plan.

This document supersedes the earlier contracts-first plan. The kernel,
storage, and server boundaries are solid (stage 0). What has never been
exercised is the thing this project exists to learn: a model loop driving a
Turn end to end. Build that first; let Room/Delivery/lane-contract decisions
be informed by what breaks.

Rationale, briefly: abstractions need real callers. The lane contract,
generalized receipts, initiator attribution, and storage-ownership changes in
decision 0006 all lack a second consumer today. Implementing them now would
be guessing at shapes the MVP will pin down for free. They remain accepted
direction in 0006 and land when their consumers land.

Follow AGENTS.md throughout: minimal diffs, behavior tests through public
APIs, no framework dependencies for the agent loop.

## Scope

One user, one execution Session, one model loop, three tools, visible end to
end in the GUI: user sends input → Turn starts → assistant text streams →
tool calls execute behind the permission boundary → Turn terminates → the
recorded facts and projection remain inspectable after a restart.

Explicitly out of scope: Room/Delivery, Mate wiring, memory, worktrees,
lane-contract implementation, receipt generalization, and a general provider
registry or provider-selection UI.

## 1. StreamFn contract and faux provider

**Why.** Every serious harness invests first in a deterministic fake model
(codex's wiremock server, pi's faux provider). The loop's tests must assert
on the journal, not on mocks of internals, and must never touch the network.

**Change.** Add `src/runtime/` with:

- A `StreamFn` contract in pi's shape: it never throws; failures are encoded
  in the stream's terminal message (stopReason `error`/`aborted` plus an
  error message). Streaming events carry full partial snapshots so consumers
  never need delta arithmetic.
- A scripted faux provider committed in src: declarative script (emit this
  text, then this tool call, then this error), zero network. This is the
  test harness for everything below.

**Tests.** Faux provider emits exactly the scripted sequence, including
scripted mid-stream errors and aborts.

## 2. Official provider adapters

**Change.** Official OpenAI Responses and Anthropic Messages implementations
behind the same `StreamFn` contract. OpenAI is the primary operator path;
Anthropic remains optional. API keys come from the environment, the model is
explicit configuration, and provider quirks stay inside each provider module.
This is a small deployment switch, not a provider registry or selection UI.
Message conversion happens at the boundary, pi-style: the loop works on
internal messages, conversion runs per request, history is never rewritten
(errored assistant messages skipped, orphaned tool calls synthesized with an
error result).

**Tests.** Request-building and stream-parsing unit tests against fixtures.
Any live-API test is opt-in via env var, never in `pnpm test`.

## 3. The model loop

**Why.** This is the MVP's core and the source of the real lessons: how
context assembly, tool batching, aborts, and turn boundaries actually behave
against the journal.

**Change.** `src/runtime/` loop that, per Turn:

- Assembles model-visible messages by projecting the journal (user inputs,
  completed assistant items, tool results). Bounded: hard cap on items and
  bytes injected, per AGENTS.md.
- Streams one model call; deltas are **ephemeral** — broadcast to the event
  hub for the GUI, never written to the journal. The journal records
  terminal facts only: assistant message completed with full text, tool
  lifecycle events, turn terminal events.
- Executes tool calls from the assistant message as a batch; a `length`
  stop reason fails the whole batch (streamed JSON arguments may parse
  while truncated — pi's rule).
- Records each tool result as an item and feeds it into the next call.
- Terminates the Turn when a model call returns no tool calls, on budget
  exhaustion, or on cancel — with the kernel's atomic close batch.
- Steer only at safe boundaries in this stage: pending inputs wait for Turn
  end, then promote and start the next Turn.

**Tests** (all faux-driven, asserting journal contents, then replaying to
verify the projection): text-only turn; turn with tool calls; length-stop
batch failure; abort mid-stream leaves an aborted terminal item, and
re-request conversion skips it; budget exhaustion fails the Turn loudly;
two queued inputs produce two sequential Turns.

## 4. Three tools behind the permission boundary

**Change.** `read_file`, `write_file`, `run_command`, scoped to the
session's workingDirectory. File tools are auto-allowed; `run_command`
requires an approval: the loop emits `permission.requested`, waits for
resolution (bounded wait with timeout → auto-deny), then proceeds. This
exercises the stage-0 binding fix in anger.

**Tests.** Auto-allowed tools run without a permission event; `run_command`
blocks until approval and its events record the binding; timeout produces a
structured denial; resolved-deny stops the tool before execution.

## 5. Orphaned Turn recovery

**Why.** The MVP will crash mid-Turn constantly during development, and
today that locks the Session forever (`requireNoActiveTurn`). This is the
single most MVP-blocking known gap.

**Change.** When a Session is opened for execution (and at server start),
replay; if an active Turn exists, append a `failTurn`-style interrupted
close batch (open items/tools/permissions closed in the same batch, per the
kernel's existing atomic-close rule).

**Tests.** Kill a session mid-Turn (write events directly), reopen, assert
the Turn is terminally failed as interrupted, open work closed, and the
Session accepts a new Turn.

## 6. GUI: streaming and approvals

**Change.**

- Render ephemeral deltas as a streaming bubble that is replaced by the
  terminal item when it lands (reconnect/replay shows only terminal facts —
  that is correct).
- Tool call rows with state; a pending permission renders allow/deny
  buttons wired to the existing resolve endpoint.
- Errors and interrupted turns are visibly distinct from clean completions.

**Tests.** Keep to pure modules (delta-buffer reducer; permission row
state). Browser verification per AGENTS.md; record the URL.

## Milestones

1. **M1 — loop on the faux provider, no GUI changes.** Items 1, 3, 4
   (permissions auto-approved by the loop), 5. The entire loop is testable
   offline.
2. **M2 — real provider + ephemeral deltas + streaming GUI.** Items 2, 6
   (streaming part).
3. **M3 — real permissions + approval UI.** Items 4 (bounded wait), 6
   (approval part).

## Done when

- `pnpm check` green; all loop behavior covered by faux-driven tests that
  assert on the journal and on replay.
- A real provider drives a full Turn in the browser: streamed text, a tool
  call, an approval, a clean terminal state.
- `sqlite3` inspection (or the events API) shows only terminal facts in the
  journal — no deltas.
- Killing the server mid-Turn and restarting leaves the Session usable,
  with the interrupted Turn visibly failed in the GUI.
- 0006's deferred items are re-triaged against what the MVP taught us, and
  the stage-2 plan (Room/Delivery or hardening) is written from that
  evidence.
