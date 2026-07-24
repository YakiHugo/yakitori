# Stage 1 MVP Implementation Plan

> Completed historical plan. Decision 0007 now controls event vocabulary,
> projection, and recovery semantics where its terminology differs here.

This is the execution plan for `docs/stage-1-mvp.md`. It is written for a
coding agent implementing the work one reviewable step at a time. Read
`AGENTS.md`, `docs/architecture.md`, and
`docs/decisions/0006-collaboration-foundations.md` before starting.

The goal is one real vertical slice:

```text
user Input is admitted durably
-> one SessionRunner owns the Session
-> one Turn starts with a pinned execution context
-> a model emits assistant content or tool calls
-> tools execute under bounded workspace and permission rules
-> results return to the model
-> the Turn reaches one durable terminal state
-> the GUI can reconnect and read the durable result
```

Do not implement Room, Task, Assignment, Delivery, memory, worktrees,
multi-provider selection, compaction, or subagents in this stage.

## How to execute this plan

- Implement the numbered steps in order. Do not begin the next step until the
  current step's tests and `pnpm check` pass.
- Keep each step reviewable. If a step approaches 500 lines of complex logic,
  split it at the smallest coherent boundary without pulling later scope
  forward.
- Before editing, inspect the current implementation and tests. Paths below
  describe the intended ownership, not permission to replace existing code
  wholesale.
- Preserve unrelated working-tree changes. Never make code or tests depend on
  `.references/`.
- Test behavior through public contracts and the durable journal. Do not mock
  SessionKernel internals.
- Use the scripted faux provider for every default test. Network access and API
  keys must never be required by `pnpm test` or `pnpm check`.
- After each step, report: files changed, behavior added, commands run, and any
  deviation from this plan. Change the plan first if a boundary must change.

Suggested branch: `feat/mvp-runtime`. Suggested commits appear under each
step, but do not commit unless the operator asks.

Track progress here. Mark a step complete only after its exit criteria and
`pnpm check` pass:

| Step | Status | Deliverable |
| ---: | :---: | --- |
| 1 | [x] | Execution identity and application composition |
| 2 | [x] | Internal model contract and faux provider |
| 3 | [x] | Text-only SessionRunner and bounded context |
| 4 | [x] | Tool registry and bounded file tools |
| 5 | [x] | Permission gate and `run_command` |
| 6 | [x] | Recovery, interruption, and shutdown |
| 7 | [x] | Server wiring and dual event delivery |
| 8 | [x] | GUI execution view and approval controls |
| 9 | [x] | OpenAI Responses and Anthropic Messages adapters |
| 10 | [x] | MVP closure and evidence |

## Decisions fixed by this plan

This document preserves the intent of `docs/stage-1-mvp.md` while resolving
the implementation ambiguities found during repository and reference review.
If the two documents differ on the following details, this plan controls:

1. **A minimal Mate binding is in scope.** Stage 1 does not build Mate
   management UI, but every executing Session and Turn must identify the
   immutable Mate revision being used.
2. **Network providers come last.** The complete Server and GUI flow must pass
   with the faux provider before OpenAI or Anthropic is introduced.
3. **`run_command` is never auto-approved outside tests.** A test may resolve
   a real permission request programmatically; the Runner must still exercise
   the same wait-and-resume path.
4. **Model adapters normalize expected failures, but the Runner still catches
   throws and premature stream termination.** An `AsyncIterable` cannot make a
   credible “never throws” guarantee across network and implementation faults.
5. **Full partial snapshots are transient.** They may be coalesced for the UI
   and are never appended to the Session journal.
6. **Any `length` stop is incomplete.** Do not execute tool calls or complete
   a Turn from a truncated model response.
7. **Tool calls execute sequentially in provider order in Stage 1.** This keeps
   workspace mutations and permission state deterministic. Read-only
   parallelism is a later optimization.
8. **`write_file` is compare-and-write, not blind overwrite.** Existing files
   require the SHA-256 returned by `read_file`; new files require an explicit
   create precondition.

## Runtime ownership map

Keep these responsibilities separate:

| Owner | Responsibility | Must not own |
| --- | --- | --- |
| SessionKernel | Validate transitions and append durable Session facts | Model calls, tool processes, timers, live UI state |
| SessionRunner | Single-flight execution, Turn progression, budgets, cancellation, recovery | Provider-specific payloads, HTTP parsing, GUI state |
| Model provider | Convert internal messages and stream one model response | Session lifecycle, permissions, persistence, tool execution |
| Tool registry | Validate tool input and perform one bounded operation | Model loops, permission decisions, Session scheduling |
| Server | Validate API requests, wake the Runner, expose durable and live events | Reimplement kernel state rules |
| GUI | Render projected durable facts plus transient snapshots | Decide execution truth or recover work |

The existing Session journal remains the source of truth. The in-memory event
hubs are notification mechanisms, not schedulers or recovery state.

## Frozen Stage 1 limits

Put these values in one exported runtime limits object. Tests may inject lower
values, but production code must not scatter numeric copies.

| Limit | Stage 1 value |
| --- | ---: |
| Model calls per Turn | 16 |
| Tool calls per Turn | 32 |
| Model-visible message blocks | 200 |
| Model-visible context | 256 KiB UTF-8 |
| One model-visible tool result | 50 KiB and 2,000 lines |
| One raw file read | 256 KiB |
| One file write | 1 MiB UTF-8 |
| Captured command output | 1 MiB combined stdout/stderr |
| Command text | 16 KiB UTF-8 |
| Assistant response/snapshot | 256 KiB UTF-8 |
| `run_command` default timeout | 120 seconds |
| `run_command` maximum timeout | 600 seconds |
| Permission wait timeout | 10 minutes |
| Grace before force-killing a command | 2 seconds |

Every truncation result must be structured and visible to the model and GUI;
never silently slice content. Context truncation drops the oldest complete
Turn groups first and never separates a tool call from its result.

## Step 1 — Execution identity and application composition

**Objective:** make every new executable Session point at one real workspace
and one immutable Mate revision before a Runner exists.

**Required changes**

- Add optional `mateId` and `mateRevisionId` fields to `session.created`,
  `CreateSessionInput`, Session projections, summaries, and Server protocol
  responses. Keep them optional in the kernel so older logs and low-level
  tests remain valid.
- Validate the identifiers at the application boundary. The Session kernel
  stores them as opaque plain strings and must not depend on MateKernel.
- Add an asynchronous application composition module under `src/server/`
  rather than expanding `http.ts` into a service locator. It should:
  - create the Session and Mate stores from one explicit database path;
  - create both kernels and both event hubs;
  - select the configured active Mate or create one default Mate when the
    store is empty;
  - fail startup if multiple active Mates exist and no explicit Mate ID was
    configured;
  - resolve one workspace from `YAKITORI_WORKSPACE ?? process.cwd()` using
    `realpath`, and verify that it is a directory;
  - inject the selected Mate revision and workspace as defaults for new HTTP
    Sessions;
  - own shutdown order for the future Runner, HTTP server, and both stores.
- Keep `createYakitoriHttpServer` dependency-injectable and usable without a
  Mate store or Runner in low-level Server tests.
- A request may omit `workingDirectory`; the application stamps the configured
  workspace. In Stage 1, reject a request that tries to select a different
  workspace. Multi-project selection is later scope.
- Do not expose Mate mutation routes or Mate UI in this step.

**Tests**

- Kernel create/replay/list tests cover the optional attribution fields on
  memory and SQLite stores.
- Application composition creates one default Mate only once across restarts.
- An explicitly configured active Mate is selected and its current revision is
  pinned to a newly created Session.
- Invalid/inactive/multiple ambiguous Mate selection fails before listening.
- Workspace normalization rejects a missing path, a file, and a conflicting
  per-request path.
- Old unattributed Session logs still replay unchanged.

**Exit criteria**

- A newly created GUI/API Session reports `workingDirectory`, `mateId`, and
  `mateRevisionId`.
- No model or tool code exists yet.

Suggested commit: `feat(server): compose execution identity`

## Step 2 — Internal model contract and scripted faux provider

**Objective:** define the provider-independent language used by the Runner and
create a deterministic model for all later tests.

**Expected modules**

```text
src/runtime/model.ts
src/runtime/faux-provider.ts
src/runtime/index.ts
test/runtime/faux-provider.test.ts
```

Use narrow internal types for:

- model-visible messages: user text, assistant text, tool call, tool result;
- tools: name, description, JSON input schema;
- a model request: system instructions, messages, tools, provider/model,
  budgets, and `AbortSignal`;
- response blocks: text and complete tool calls;
- stop reasons: `end_turn`, `tool_use`, `length`, `error`, and `aborted`;
- stream events: full assistant snapshots and exactly one terminal response.

`StreamFn` returns an `AsyncIterable`. Adapters should encode expected provider
errors in a terminal response. The later Runner must still normalize a thrown
error, malformed event, end-of-stream without a terminal response, duplicate
terminal response, and abort.

The faux provider consumes a declarative script with one response per model
call. A script can:

- emit a sequence of text snapshots;
- finish with text and/or complete tool calls;
- finish with any stop reason;
- throw before or during iteration;
- end without a terminal event;
- wait until its signal is aborted;
- assert selected properties of the request it received.

Do not imitate a real provider wire format in the faux provider.

**Tests**

- Exact scripted snapshot and terminal ordering.
- Multi-call scripts advance once per model request.
- Mid-stream throw, premature end, explicit error, and abort are distinct.
- Requests are retained for whole-object assertions without mutation.

**Exit criteria**

- The faux provider has no timers, network access, or environment dependency.
- No SessionKernel or Server import exists in the model contract.

Suggested commit: `feat(runtime): add faux model contract`

## Step 3 — Text-only SessionRunner and bounded context

**Objective:** turn durable pending Inputs into sequential text-only Turns and
prove replay before introducing tools.

**Expected modules**

```text
src/runtime/session-runner.ts
src/runtime/model-context.ts
src/runtime/live-events.ts
test/runtime/session-runner.test.ts
test/runtime/model-context.test.ts
```

**Runner contract and ownership**

- Expose one `wake(sessionId): Promise<void>` operation. Calling it marks the
  Session dirty, starts one worker if none exists, and resolves when that
  Session is idle again.
- Concurrent calls for the same Session must share one execution lane. A wake
  arriving while the worker is about to stop must cause another durable-state
  check rather than being lost.
- Different Sessions may run independently, although the Stage 1 GUI creates
  only one.
- The worker repeatedly reloads the durable projection. It selects the oldest
  admitted Input, starts one Turn atomically through the existing kernel, and
  does not steer an active Turn. Later Inputs wait for the next Turn.
- Runtime writes go only through SessionKernel. After each committed mutation,
  publish the returned envelopes to the durable event hub exactly once.
- A background wake must not create an unhandled rejection. Unexpected runtime
  faults must be converted to a durable failed Turn when one exists and be
  reported through an injected error callback.

**Pinned Turn execution context**

Add an explicit typed execution context to `turn.started` and its projection:

- `mateId` and `mateRevisionId` copied from the Session;
- provider and model identifiers;
- canonical working directory;
- enabled tool names;
- approval policy;
- the actual limits used for the Turn.

Do not hide this contract in arbitrary metadata. The Runner loads the pinned
Mate revision and uses its instructions as the system prompt. Existing Turn
events without this field remain replayable, but the Stage 1 Runner refuses to
start an unattributed or workspace-less execution.

**Context assembly**

- Build context from durable event order, not timestamps or GUI state.
- Include the current Input and complete prior user/assistant/tool exchanges.
- Exclude transient snapshots, in-progress items, failed partial assistant
  output, and raw provider events.
- Bound total UTF-8 bytes and item count. Drop the oldest complete prior Turn
  groups first. Always retain the current Input.
- Keep tool call/result pairs together. If persisted history is inconsistent,
  synthesize a bounded error result at the provider-conversion boundary rather
  than rewriting history.
- Attach provider/model, call index, selected durable event/item IDs, and
  truncation counts to the final output item's `providerMetadata`. Do not store
  prompts, credentials, or hidden reasoning there.

**Text-only progression**

- Stream full text snapshots through the transient hub under a stable
  `streamId`; cap and coalesce them to at most 20 publications per second.
- Do not journal snapshots.
- On `end_turn` without tool calls, atomically append one completed assistant
  Item and complete the Turn with that Item as output. Add the narrow kernel
  command needed to make this one append batch; do not leave a completed final
  Item attached to an active Turn across a crash boundary.
- Treat `length`, `error`, malformed stream, and budget exhaustion as failed
  Turns with structured error codes. Treat a user abort as cancellation.
- An empty but valid `end_turn` may complete without an output Item.

**Tests**

- Text-only Turn: exact journal sequence and replayed projection.
- Two queued Inputs produce two sequential Turns in admission order.
- Several concurrent wakes result in one active model call.
- A wake at worker shutdown is not lost.
- Prior successful history appears in the second model request.
- Context caps drop whole old Turn groups and report truncation metadata.
- Snapshots reach the transient subscriber but are absent from SQLite/replay.
- Throw, premature end, duplicate terminal, `length`, oversized output, model
  budget exhaustion, and abort each reach the specified terminal state.

**Exit criteria**

- `InputAdmitted -> InputPromoted -> TurnStarted -> ItemAppended ->
  TurnCompleted` runs offline through the public runtime contract.
- Refresh/replay reproduces the completed assistant output from durable facts
  alone.

Suggested commit: `feat(runtime): run text turns`

## Step 4 — Tool registry and bounded file tools

**Objective:** support model -> tool -> model continuation without permissions
or shell execution yet.

**Expected modules**

```text
src/runtime/tools/registry.ts
src/runtime/tools/read-file.ts
src/runtime/tools/write-file.ts
src/runtime/tools/path-policy.ts
test/runtime/tools/*.test.ts
```

Use one small tool contract containing name, description, input schema, and an
`execute(input, context)` function. Tool input is `unknown` until the tool
validates it. Do not add a general schema framework solely for three tools.

**Path policy**

- Resolve the Session workspace once with `realpath`.
- For reads and existing writes, resolve the target with `realpath` and verify
  it is the workspace or a descendant.
- For new files, resolve the existing parent directory before applying the
  same containment check.
- Reject absolute paths outside the workspace, `..` escapes, symlink escapes,
  directories where files are expected, NULs, and oversized inputs.
- Return structured errors; never leak arbitrary host file contents through an
  error message.

**Tool behavior**

- `read_file` accepts a relative path and optional bounded range. It returns
  UTF-8 text, byte/line counts, SHA-256, and explicit truncation metadata.
- `write_file` accepts path, full UTF-8 content, and a precondition:
  - existing file: `expectedSha256` must equal the latest `read_file` hash;
  - new file: `expectedSha256` must be `null`, and creation fails if the file
    already exists.
- Write through a temporary file in the target directory and rename only after
  the precondition succeeds. Preserve the existing file mode where practical.
- Do not add recursive directory creation, delete, move, binary editing, or
  patch interpretation in Stage 1.

**Loop integration**

- A terminal model response with `tool_use` must contain at least one complete
  tool call. Persist completed ToolCall Items in provider order.
- Execute calls sequentially. File tools are auto-allowed by runtime policy.
- Persist ToolRequested/Started/terminal lifecycle and one ToolResult Item per
  call, then include all results in the next model request.
- Add a narrow atomic kernel command for a tool outcome plus its ToolResult
  Item. No crash boundary may leave a terminal result Item paired with an open
  Tool. Success, failure, denial, and cancellation must remain distinguishable.
- A non-`tool_use` response containing tool calls is a provider protocol error.
- A `length` response never executes any included calls.

**Tests**

- Read -> result -> second model call -> final text, asserted against journal
  and replay.
- Existing compare-and-write success; stale hash rejection; explicit new-file
  creation; existing-file collision.
- Path traversal and symlink escape for read and write.
- UTF-8 and byte/line truncation metadata.
- Unknown tool and malformed input become bounded ToolResult errors that the
  next model call can observe.
- Two tool calls execute and return in provider order.
- Crash-shape tests prove tool outcome and ToolResult are one append batch.

**Exit criteria**

- The full faux-driven loop can safely read and change a temporary workspace.
- No tool can access outside that workspace through its path argument.

Suggested commit: `feat(runtime): add bounded file tools`

## Step 5 — Permission gate and `run_command`

**Objective:** exercise a real, durable approval boundary before any host
command starts.

**Expected modules**

```text
src/runtime/permission-gate.ts
src/runtime/tools/run-command.ts
test/runtime/permission-gate.test.ts
test/runtime/tools/run-command.test.ts
```

**Permission lifecycle**

- For every `run_command` call, request a permission and bind it one-to-one to
  the Tool request before waiting.
- Strengthen the shared permission guard so a Tool with a
  `permissionRequestId` must find that exact permission, bound to that exact
  Tool, in resolved-allow state. A Tool without one is allowed only because
  runtime policy classified it as auto-allowed before ToolRequested.
- The durable permission projection is truth. The in-memory PermissionGate
  only wakes waiters; after every wake the Runner rereads the projection.
- Allow and deny are durable Server commands. Timeout durably resolves as deny
  with reason kind `timeout`. Abort closes the pending permission through the
  Turn's atomic cancellation path.
- A denial/cancellation records a ToolResult explaining that no process was
  started, then continues the model loop so the model can respond or choose a
  different action.
- Never add a production bypass that directly returns allow. Tests approve by
  calling the same resolve contract as the future GUI.

**Command execution**

- Accept `{ command, timeoutSeconds? }`; validate length and the timeout cap.
- Run in the pinned workspace. Stage 1 is not a sandbox: the permission reason
  and future GUI must state that the command executes with the host user's
  filesystem, process, environment, and network authority.
- Inherit the process environment for actual execution, but never place the
  environment or secrets into events, logs, model context, or errors.
- Capture stdout/stderr with the frozen limits and structured truncation.
  Continue draining both pipes after the capture cap so a noisy child cannot
  block on a full pipe.
- A normal non-zero exit is a completed Tool result containing exit code,
  stdout, and stderr. Spawn errors and timeouts are failed Tool outcomes.
- Connect `AbortSignal`; terminate the process group, wait the grace period,
  then force-kill. Do not leave child processes running after Turn cancel.

**Tests**

- The process cannot start before durable allow.
- Allow starts exactly one process; duplicate resolve cannot start another.
- Deny, timeout, and abort start no process and create the correct result.
- Permission P cannot authorize T2 after being bound to T1.
- Non-zero exit, timeout, spawn failure, stdout/stderr capture, output
  truncation, and child-process cancellation.
- The second model request receives the command result or denial.
- Use injectable timers/process launchers where needed; tests must not sleep for
  minutes or depend on shell-specific host state.

**Exit criteria**

- Every host command is visibly blocked on a durable, one-call approval.
- Cancelling a Turn removes both the waiter and the child process.

Suggested commit: `feat(runtime): gate command execution`

## Step 6 — Recovery, interruption, and shutdown

**Objective:** ensure a restart or cancellation never leaves a Session
permanently locked and never blindly repeats an external side effect.

**Recovery policy**

- Stage 1 supports exactly one application runtime for one database. Acquire
  an exclusive runtime lock in the configured store directory before
  recovery. Record the owner PID and start time, fail clearly while a live
  owner holds it, reclaim a demonstrably stale lock after a crash, and release
  it on graceful shutdown. Do not treat an unlocked database as permission to
  recover while another runtime may still be active.
- Run startup recovery before accepting HTTP requests; do not run orphan
  cleanup on ordinary Session reads.
- List all Sessions with pagination.
- For an active Turn, atomically close open Items, Tools, and permissions and
  fail the Turn with code `runtime_interrupted`. Never retry an in-flight or
  ambiguously completed command automatically.
- After orphan cleanup, wake every Session with admitted Inputs. This covers a
  crash after Input admission but before Turn start.
- Publish all recovery events through the durable hub after commit.
- Make recovery idempotent: running it again produces no new events for an
  already terminal Turn.

**Interruption contract**

- Add `SessionRunner.interrupt({ sessionId, turnId, reason })`.
- Verify the requested Turn is the currently active Turn, abort the provider,
  permission wait, or process, and serialize the durable `cancelTurn` batch
  with the lane owner. A completion/cancel race must produce one terminal Turn
  event, never both.
- Add a bounded `SessionRunner.close()` used by graceful shutdown. It stops new
  work, cancels active work with reason `server_shutdown`, waits for terminal
  persistence, and then allows stores to close.
- Abrupt process death is handled by startup recovery, not shutdown hooks.

**Tests**

- SQLite histories interrupted during model stream, permission wait, and Tool
  execution recover to one failed Turn with all work closed.
- A Session containing only admitted Inputs starts them after recovery.
- Recovery is idempotent.
- A second live application cannot acquire the runtime lock; a stale lock is
  reclaimed safely after simulated owner death.
- Interrupt during each wait point produces one cancelled Turn.
- Completion vs interrupt race has one valid terminal outcome.
- New wake calls are rejected or ignored deterministically after close.

**Exit criteria**

- Killing and restarting between any durable runtime stages leaves the Session
  usable.
- No recovery path automatically reruns `run_command`.

Suggested commit: `feat(runtime): recover interrupted turns`

## Step 7 — Server wiring and dual event delivery

**Objective:** expose the complete faux-driven runtime through the product
Server without mixing transient UI state into the durable protocol.

**API additions**

```text
POST /sessions/:sessionId/turns/:turnId/cancel
POST /sessions/:sessionId/turns/:turnId/permissions/:permissionRequestId/resolve
```

The permission body contains `behavior: "allow" | "deny"` and an optional
structured reason. Do not expose `ask_cancelled` as a user choice.

**Admission and wakeup**

- After a successful or idempotently replayed Input admission, call
  `runner.wake(sessionId)` without holding the HTTP response open for the full
  Turn. Replayed admission must still wake because the original process may
  have crashed after commit and before scheduling.
- Return admission only after the Input is durable. Runtime failure is later
  represented by durable Turn events, not by changing the admission response.
- Permission resolve first commits through SessionKernel, publishes the
  envelope, then notifies the PermissionGate.

**SSE event classes**

- Preserve `session.event` for durable `EventEnvelope`s with numeric SSE IDs
  and replay/resume behavior.
- Add `session.transient` for bounded `LiveSessionEvent`s without an SSE ID.
  These events are never replayed and must not advance `Last-Event-ID`.
- Subscribe before durable replay as the current Server does. Buffer bounded
  live notifications during replay, then switch to live delivery without a
  durable sequence gap.
- At minimum, support `assistant.snapshot` containing session/turn/stream IDs,
  full bounded text, and timestamp. Coalesce by stream ID rather than building
  an unbounded queue for a slow subscriber.
- The terminal assistant Item carries the same `streamId` in provider metadata
  so the GUI can replace the transient bubble.

**Composition and shutdown**

- The application composition from Step 1 now constructs and injects the
  provider, Runner, PermissionGate, tool registry, and both hubs.
- For browser verification with `YAKITORI_PROVIDER=faux`, provide committed,
  bounded development scenarios for text, file Tool, command, and error flows.
  Select them through configuration; do not make the faux provider parse
  magic user prompt text or execute arbitrary fixture code.
- Run recovery before `listen`.
- On shutdown, stop accepting HTTP, close the Runner, then close stores.

**Tests**

- HTTP admission returns promptly and eventually produces a faux-driven
  terminal Turn.
- Idempotent admission wakes previously pending work without duplicating it.
- Permission allow/deny validates Session, Turn, request binding, and state.
- Cancel validates Session/Turn binding.
- One SSE connection receives transient snapshots and durable terminal events;
  reconnect receives only durable events.
- Transient events do not change the durable cursor.
- Runtime commands publish every committed event in sequence.

**Exit criteria**

- A headless HTTP test drives the entire fake flow, including an approval, to
  durable completion.
- Existing durable SSE resume tests remain valid.

Suggested commit: `feat(server): expose session runtime`

## Step 8 — GUI execution view and approval controls

**Objective:** make the faux-driven vertical slice understandable and
controllable in the browser.

**Required changes**

- Extract a pure GUI projection/reducer from durable Session events plus
  transient snapshots. The DOM renderer consumes this view model rather than
  scattering event interpretation through click handlers.
- Render, in durable event order:
  - user Inputs;
  - completed assistant messages;
  - one transient assistant bubble per active `streamId`;
  - Tool calls with requested/running/completed/failed/cancelled state;
  - Tool results with explicit truncation/error/denial markers;
  - pending permission cards with allow and deny actions;
  - failed, interrupted, and cancelled Turns distinctly.
- Replace the transient assistant bubble when the matching completed Item
  arrives. Reconnect may make the bubble disappear until the next transient
  event; durable history must remain correct.
- Add a cancel control only while a Turn is active.
- Display the pinned Mate name/revision and workspace. Do not add Mate editing
  or workspace selection.
- Keep raw event JSON available behind a compact diagnostics disclosure; it is
  useful during the MVP but must not be the primary conversation UI.
- Disable duplicate approval/cancel clicks while the request is in flight, but
  rely on Server state validation rather than UI state for correctness.

**Tests and verification**

- Pure reducer tests: snapshot replacement, duplicate durable event,
  out-of-order transient event, replay without transient state, permission
  transitions, Tool transitions, and terminal Turn rendering.
- HTTP/UI errors remain visible and do not destroy durable rendered history.
- Run `pnpm dev`, open `http://127.0.0.1:5173`, and manually verify:
  1. text-only streaming and terminal replacement;
  2. file Tool call and result;
  3. command waiting for approval, allow, and deny;
  4. cancel during streaming and command execution;
  5. browser refresh and Server restart replay.
- Record the exact URL and scenarios checked in the implementation report.

**Exit criteria**

- A user can understand whether the Mate is generating, waiting for approval,
  running a Tool, completed, failed, or cancelled without reading raw events.

Suggested commit: `feat(gui): show session execution`

## Step 9 — Official provider adapters

**Objective:** replace only the model boundary in an already proven system.

**Required changes**

- Add the official OpenAI and Anthropic TypeScript SDKs as ordinary runtime
  dependencies; do not hand-build SSE parsing and do not introduce an agent
  framework.
- Implement OpenAI Responses and Anthropic Messages adapters behind `StreamFn`.
- Convert internal messages at request time. Provider payload types and quirks
  stay inside the adapter.
- Map text and complete tool-use blocks to internal blocks. Emit full partial
  snapshots while streaming and one normalized terminal response.
- Map provider stop reasons, usage, request ID, and bounded non-secret metadata.
  Do not persist raw responses or hidden reasoning.
- Skip failed partial assistant output when rebuilding provider history.
  Synthesize a bounded error ToolResult for an orphaned historical call at the
  conversion boundary without mutating the journal.
- Read `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` only in application
  configuration. Require explicit `YAKITORI_MODEL` when either network
  provider is selected; do not bake a model name that will silently become
  stale.
- Select the provider through `YAKITORI_PROVIDER=faux|openai|anthropic`. This
  remains deployment configuration, not a general provider registry or GUI.

**Tests**

- Request construction from fixed internal histories, including tools and
  prior results.
- Fixture-driven stream conversion: text, multiple content blocks, tool use,
  usage, provider error, abort, malformed/incomplete tool input, and `length`.
- No default test reaches the network.
- An optional manually invoked smoke path may use environment credentials, but
  it must not run under `pnpm test` or CI.

**Manual verification**

- Start the application with explicit provider/model/key configuration.
- Complete one text Turn, one file Tool Turn, one approved command Turn, one
  denied command Turn, and one cancellation in the browser.
- Confirm provider errors become terminal Session facts and the next Input can
  still start.

**Exit criteria**

- The same Runner, tools, permissions, Server, and GUI work unchanged with
  faux, OpenAI, and Anthropic adapters.

Suggested commit: `feat(runtime): add provider adapters`

## Step 10 — MVP closure and evidence

**Objective:** finish the stage with reproducible evidence rather than a demo
that only works on the latest process state.

**Required verification**

- Run `pnpm format`, `pnpm check`, and `pnpm build`.
- Inspect a real SQLite Session after a completed tool Turn. Confirm that it
  contains terminal assistant/tool/permission/Turn facts and no transient text
  snapshots.
- Perform the restart drill at all observable wait points:
  - after Input admission;
  - during model streaming;
  - while permission is pending;
  - while a command is running;
  - after tool result commit but before the next model call.
- Confirm every recovered Session accepts a later Input.
- Confirm all model-visible and tool outputs have hard caps and structured
  truncation markers.
- Confirm no command can run without one durable allow decision bound to it.
- Update `README.md` with configuration and the exact local run flow.
- Update `docs/architecture.md` only where the implemented boundary differs
  from its current description.
- Re-triage decision 0006 using evidence from the runtime. Write the next stage
  plan separately; do not implement Room/Delivery as part of cleanup.

**Final report**

Record:

- commands and browser URL used;
- automated test counts;
- manual scenarios passed;
- relevant environment variable names, never values;
- remaining limitations and known failure modes;
- any ADR or contract change made during implementation.

Suggested commit: `docs: record mvp runtime evidence`

## Stage 1 definition of done

Stage 1 is complete only when all of the following are true:

- One attributed Mate Session runs Inputs sequentially through one recoverable
  SessionRunner.
- Faux-driven tests cover text, tools, approval, denial, cancellation, budgets,
  queueing, replay, and restart recovery through public contracts.
- The browser shows transient progress while durable replay remains sufficient
  to reconstruct every terminal result.
- File Tools cannot escape the configured workspace through their path input,
  and writes use explicit compare-and-write preconditions.
- Every `run_command` is bound to one durable allow decision, has timeout and
  output caps, and is killed on cancellation.
- OpenAI and Anthropic are only provider adapters; switching between them does
  not change the Runner, journal, tools, permissions, Server, or GUI.
- `pnpm check` and `pnpm build` pass without network access.
- No Stage 2 collaboration, memory, worktree, or multi-provider abstraction has
  leaked into the implementation.
