# Architecture Convergence Register

Status: living register of confirmed architecture convergence work. This is
not an implementation specification: code, public types, and focused tests
remain authoritative. This register keeps only unfinished convergence work;
completed behavior belongs in code, focused tests, and module-local comments.

Yakitori has no production users or durable compatibility obligation yet.
Schema-breaking changes and deletion of development-only compatibility paths
are allowed when they produce a clearer target architecture.

Reference baseline:

- Primary: `.references/public/codex` and `.references/public/grok-build`.
- Secondary references are consulted only when the primary references leave a
  concrete gap.

## How to use this register

- Work one ownership module at a time instead of fixing individual symptoms.
- Before deleting a surface, re-check its production, dynamic, persisted, and
  test consumers.
- Prefer one source of truth over synchronization helpers.
- Preserve validation, authorization, recovery, and storage ownership
  boundaries even when their implementations look repetitive.
- After a module lands, remove resolved prose that merely duplicates the new
  code and tests.

## Module map and order

| ID | Module | Priority | Depends on | Status |
| --- | --- | --- | --- | --- |
| M1 | Durable event and execution-item protocol | P0 | None | Done |
| M2 | Context manager, model capacity, and compaction | P0 | M1 lifecycle decisions | In progress |
| M3 | Tool catalog, execution policy, and permissions | P0 | M1 item decisions | In progress |
| M4 | Persistence, recovery, and keyed concurrency | P1 | M1, M3 permission terminal states | Planned |
| M5 | Provider transport, retry, and usage accounting | P1 | M2 capacity contract | In progress |
| M6 | Server lifecycle, errors, and event delivery | P1 | M1, M4 | In progress |
| M7 | GUI projections and transient state | P1 | M1 | In progress |
| M8 | Instructions, environment context, and shell discovery | P2 | M2 StepContext boundary | Done |
| M9 | Agent collaboration and Mate lifecycle | P2 | M1, M3 | In progress |
| M10 | Public module surface and test support | P3, cross-cutting | Owning modules stabilized | Planned |

Current execution order:

1. Close M2 context capacity and M3 tool/permission ownership.
2. Close M4 persistence/recovery and M6 process/error lifecycles.
3. Adapt provider and GUI boundaries in M5/M7, then finish M9 lifecycle cleanup.
4. Perform M10 export and dead-surface cleanup after callers have moved.

## M2 — Context manager, model capacity, and compaction

Status: in progress. Complete-request estimation and an in-memory
provider-usage baseline have landed. Durable calibration and capacity-surface
cleanup remain.

### Remaining problems

- History selection intentionally uses cheap message/byte caps before the
  complete request exists, while final admission uses token and image
  estimates. These are valid separate policies, but their diagnostics and
  fallback behavior are not named clearly enough.
- A model without catalog token capacity still falls back to the fixed 256 KiB
  history-selection budget and cannot perform a real context-window admission
  check.
- Provider usage corrects later requests only through an in-memory Session
  baseline. Restart/resume cannot recover it from durable Turn usage, and
  compaction requests use estimates alone.
- `ResolvedModelCapacity` exposes default, configured, maximum, and percentage
  fields even though execution consumes only the effective token window.

### Target boundary

Keep the two capacity stages explicit:

```text
history selection: message blocks + serialized bytes
final admission:   complete request tokens + output reserve
```

`ContextManager` owns history normalization, selection, tool-result
truncation/pruning, compaction, and fork/rollback baselines. Complete-request
assembly owns final admission; it must run after every system, history, agent,
tool-schema, and image addition.

Capacity must be computed over the complete request:

```text
base/system instructions
+ model-visible history
+ world-state and inter-agent additions
+ serialized tool definitions/schemas
+ modality estimates
+ reserved output capacity
= estimated request capacity
```

The final admission stage uses two authorities:

- Before sending: one transparent `4 UTF-8 bytes/token` text heuristic without
  a hidden safety multiplier, plus modality/detail-aware image estimates. It
  must count the exact serialized structures that the provider adapter will
  receive.
- After sending: provider-reported input/output/cache usage is authoritative
  evidence. Persist and rehydrate the last provable request-prefix baseline so
  restart/resume does not silently return to estimates.

Image accounting must follow the Codex direction: a conservative fixed cost
for ordinary images, dimension/patch-aware estimation for original detail when
dimensions are known, and provider usage after completion as the authority.

Do not add a durable `ContextPrepared` event now. Codex exposes usage/context
window and compaction facts while keeping detailed estimates in trace/metrics.
Yakitori should likewise keep pruning/estimation diagnostics outside assistant
events and outside the durable conversation protocol until a concrete product
consumer exists.

### Lifecycle invariants to preserve

These are required boundaries, not duplicate state:

- `TurnContext` is fixed for one user Turn.
- `StepContext` is fixed for one model request; later Steps may observe new
  world state and a newly finalized tool router.
- `reference_context_item` is the Turn-configuration baseline needed by
  resume/fork and contextual reinjection.
- `world_state_baseline` is the dynamic state the model has already seen.
- A full fork preserves the provable history prefix and its baselines.
- A truncated fork clears any baseline that can no longer be proved by the
  retained prefix.
- Compaction atomically replaces covered history and establishes the new
  baselines.

### Remaining work

- Persist or reconstruct the provider-usage prefix baseline used by final
  admission and define when compaction/fork invalidates it.
- Give uncataloged models an explicit token-capacity policy instead of silently
  substituting the byte-selection fallback.
- Narrow resolved Turn capacity to the effective token window consumed by
  execution; keep catalog maxima at catalog/validation boundaries.
- Label selection-byte diagnostics separately from final request-token
  diagnostics so neither is presented as the other.

### Done when

- No provider request can append system, tool-schema, agent, or image content
  after final admission.
- Compaction tests cover text, JSON schema, multilingual/code content, images,
  output reserve, provider-usage correction, and restart/resume calibration.
- Fork, rollback, resume, and compaction tests prove baseline invalidation and
  replacement semantics.

Reference anchors:

- `.references/public/codex/codex-rs/core/src/context_manager/history.rs`
- `.references/public/codex/codex-rs/core/src/session/step_context.rs`
- `.references/public/codex/codex-rs/protocol/src/openai_models.rs`
- `.references/public/grok-build/crates/codegen/xai-token-estimation/src/lib.rs`
- `.references/public/grok-build/crates/codegen/xai-chat-state/src/image_budget.rs`

## M3 — Tool catalog, execution policy, and permissions

Status: in progress. The finalized per-Step router and shared file-path
resolution boundary have landed; limit ownership and the remaining command /
mutation approval-policy cleanup are still open.

### Confirmed problems

- `RuntimeLimits` mixes Session semantics, per-call tool requests, and process
  safety caps. Eight tool-side keys are persisted and validated but tools read
  module constants instead.
- `RuntimeTool.autoAllow` is always true in production, leaving the permission
  request path without a real trigger.
- Permission timeout defaults and abort detection are duplicated; `now/sleep`
  dependency injection has no production caller.

### Target boundary

Split limits into:

- `SessionExecutionPolicy`: model/tool calls per Turn, context and
  model-visible result budgets, compaction and response budgets;
- per-call tool input: requested timeout/output budget where the tool contract
  genuinely supports it;
- `RuntimeSafetyCaps`: file-write size, raw/persisted command output, maximum
  timeout, kill grace, and streaming-frame caps. These are process constants
  and are not persisted as Session configuration.

The effective value is bounded by the most restrictive applicable layer:

```text
effective = min(call request, Session policy, hard safety cap)
```

Permissions remain a core safety boundary. Remove the speculative `autoAllow`
surface and make approval requirements a real result of tool policy for file
mutation and command execution. One Permission owner controls request,
resolution, timeout, abort, and recovery expiry.

The current product default is YOLO (`never` ask), matching its single-user
coding-agent stage. Path normalization, bounded I/O, compare-and-write,
non-regular-file rejection, and command fuses are hard
safety policy and do not disappear in YOLO mode. A future interactive mode
changes only approval policy; it must not change tool schemas or path
resolution.

### Remaining work

- Remove tool-side keys from persisted `runtimeLimits` through a clean schema
  break.
- Wire real approval requirements; do not delete the permission system merely
  because the current trigger is inert.
- Remove unused PermissionGate clock injection and duplicated timeout defaults.

### Done when

- Changing Session policy changes only documented Session behavior; changing a
  safety cap cannot be serialized as a Session preference.
- Permission allow, deny, expire, abort, recovery, and policy bypass have
  integration tests through the real tool loop.

Reference anchors:

- `.references/public/codex/codex-rs/core/src/tools/router.rs`
- `.references/public/codex/codex-rs/core/src/tools/context.rs`
- `.references/public/codex/codex-rs/core/src/exec.rs`

## M4 — Persistence, recovery, and keyed concurrency

### Confirmed problems

- Session kernel, Mate kernel, and JSONL event store separately implement the
  same per-key Promise-tail serialization primitive.
- Recovery returns reports no production caller consumes.
- Recovery detects stale permission requests but does not terminalize them.
- Session summary fields are explicitly expanded at projection, cache, and API
  boundaries. Some repetition is necessary, but exact same-domain conversion
  should have one owner.
- Several development-era legacy event fields and SQLite path fallbacks carry
  compatibility cost without real users.

### Target boundary

Provide one small `KeyedSequencer` implementation. Session, Mate, and EventStore
each own a separate instance and choose their own key; sharing the algorithm
must not merge their queues or lifecycle ownership.

Recovery is an effectful startup reconciliation, not a report generator:

```text
started Turn without terminal event -> append interrupted terminal event
pending Input                      -> wake owning Session runner
stale Permission                   -> append expired resolution
```

It may emit one structured operational log summary, but should not return data
that evaporates at the caller.

Keep boundary mappings explicit:

- Projection to domain `SessionSummary` may be shared.
- Cache validation remains explicit because disk is a trust boundary.
- API mapping remains explicit because field names and exposure are a wire
  contract.
- Do not create a universal field list that automatically leaks new internal
  fields into cache and API representations.

### Remaining work

- Introduce and test KeyedSequencer FIFO, failure continuation, cleanup, and
  cross-key concurrency.
- Make recovery close every discovered nonterminal lifecycle.
- Simplify `recoverSessions()` to an effect-oriented return type.
- Remove development-only persistence compatibility in the same deliberate
  schema break as M1/M3.

### Deliberately retained

- EventStore `structuredClone` remains an ownership boundary.
- The validated `session.json` summary cache remains a legitimate derived
  cache.
- `sessionListOrder` and event-store `order: "created"` remain because cursor
  and recovery consumers are real.

### Done when

- Concurrent same-key writes are FIFO and different keys remain concurrent.
- Restart leaves no active Turn or stale pending Permission without a terminal
  durable fact.
- Cache corruption falls back to journal reconstruction.
- Internal-only summary fields cannot enter the public API accidentally.

## M5 — Provider transport, retry, and usage accounting

Status: in progress. Provider usage now anchors later requests within one
process; shared transport policy and durable baseline recovery remain.

### Confirmed problems

- Anthropic and OpenAI adapters duplicate retryable status sets, status detail
  extraction, and terminal error conversion.
- Retry policy is therefore maintained by manual provider synchronization.
- Provider usage corrects later request admission only through an in-memory
  baseline; restart/resume and compaction do not recover that evidence.
- The Codex provider is the only production provider without a focused
  contract test.

### Target boundary

Provider adapters translate request/stream protocols only. Shared transport
policy owns retryable HTTP/transport classification, retry delay/backoff,
attempt limits, terminal error shape, and retry observability. Streaming retry
state may remain separate from unary transport retry when their lifecycle and
telemetry differ, as in Codex.

Normalize exact provider usage once and pass it to both durable Turn accounting
and M2's capacity authority.

### Done when

- Providers cannot disagree on the same HTTP status solely because of copied
  helpers.
- Retryable, terminal, disconnect, and exhausted-retry behavior have shared
  contract tests plus provider translation tests.
- Codex/OpenAI/Anthropic stop reasons and usage normalize to the same runtime
  contract.

Reference anchors:

- `.references/public/codex/codex-rs/codex-api/src/provider.rs`
- `.references/public/codex/codex-rs/core/src/responses_retry.rs`

## M6 — Server lifecycle, errors, and event delivery

Status: in progress.

### Confirmed problems

- `start.ts` and `desktop-entry.ts` duplicate server startup, signal, and
  shutdown behavior.
- The public HTTP constructor accepts handlers, kernel, or event store even
  though production uses handlers; test convenience widens the production
  contract.
- Error classification is repeated through local `isInvalidState`,
  `isNotFound`, and `isAbortError` implementations.
- Durable and transient EventHubs invoke arbitrary listener callbacks and send
  errors to an optional `onListenerError` hook that production never sets.
  Subscriber failure is therefore silent.

### Target boundary

One `serveYakitori` owner handles startup, listening, signal registration,
graceful drain, forced shutdown, and resource closure. CLI and desktop entry
points only parse/derive options and call it.

The production HTTP server accepts one explicit handler/service boundary.
Tests obtain kernel/store convenience through test-support constructors rather
than a three-way production union.

Establish a shared error taxonomy and boundary policy:

- domain/kernel: invalid argument, invalid state, not found, corrupt log;
- provider: authentication, rate limit, retryable transport, protocol;
- tool: validation, permission denial, execution;
- infrastructure: filesystem, storage, and background-task failure.

Extend the kernel guard to support optional code matching, preserve causes,
map expected errors once at HTTP/runner boundaries, and send unexpected or
background failures to one mandatory reporter.

Event delivery must not roll back durable writes when a subscriber fails, but
failure must be observable. Give subscribers isolated asynchronous delivery;
on failure log component, Session, event range, and error, then remove the
broken subscriber without affecting others.

### Done when

- CLI and desktop cannot drift in shutdown semantics.
- No production API accepts dependencies solely for test convenience.
- No fire-and-forget Promise or event listener can fail silently.
- HTTP, runner, provider, tool, and storage errors preserve one stable code and
  cause chain through their owning boundary.

Reference anchors:

- `.references/public/codex/codex-rs/app-server/src/lib.rs`

## M7 — GUI projections and transient state

Status: in progress. Model-selection restoration and transient-state cleanup
remain.

### Confirmed problems

- `formatDuration` and `truncateLine` have duplicate implementations.
- `modelSelectionReady` and `restoringModelSelections` represent one restore
  lifecycle through a global boolean plus a per-Session Set; the Set's extra
  granularity is not currently observable.
- Turn usage/metrics are durable and expected to gain product consumers, while
  `streamStatus` is only connection state.

### Target boundary

Represent model-selection restoration with one explicit status owned by the
current selection (`loading | ready | failed`) unless real concurrent
per-Session restoration creates a second consumer.

Keep usage and metrics in durable Turn facts and derive GUI selectors from
them. Keep streaming connection status transient and retain it only when UI or
reconnection logic consumes it.

### Done when

- Session switching cannot expose a stale model selection.
- Usage/metrics replay identically after restart.

## M9 — Agent collaboration and Mate lifecycle

Status: in progress. Speculative Mate and Agent lifecycle surfaces remain.

### Confirmed problems

- Agent `pending_init` is assigned and then synchronously overwritten by
  `running` before any await, event, or caller observation.
- `reviseMate` and `setMateLifecycle` have no production write consumer while
  Mate/Room collaboration is explicitly a later product stage.

### Target boundary

Delete `pending_init` while initialization is synchronous. Reintroduce it only
when a child Session is registered and externally visible before asynchronous
initialization completes, which is why the state is real in Codex.

Keep the smallest Mate surface required by the current single-Mate coding
agent. Preserve production-consumed create/read behavior, but remove speculative
revision/lifecycle writes and their dedicated events until Rooms supply real
owners and consumers.

### Done when

- Every exposed Agent state is observable and has a tested transition.
- Current coding-agent behavior has no dependency on speculative Room/Mate
  lifecycle APIs.

## M10 — Public module surface and test support

### Confirmed problems

- `faux-provider.ts` is exported from the production runtime despite having no
  production consumer and overlaps naming with another test scenario stream.
- Barrel files re-export internal tool helpers and duplicate exports across
  registry/index boundaries.
- Multiple dead exports expose internal environment, world-state, lock, and
  prompt helpers.
- Generic `isRecord` checks are repeated throughout typed internal code rather
  than concentrated at input boundaries.

### Target boundary

Move fake providers and scenario helpers to test support. Public barrels expose
only intentional cross-module contracts and construction entry points; module
helpers remain local.

Share at most a primitive JSON-object guard. HTTP, event-log, config, and
provider boundaries retain named shape decoders because they validate
different trust contracts. Once a value enters typed internal code, do not
revalidate it through generic record checks.

Run this cleanup after each owner module has stabilized so export deletion does
not obscure the architectural move.

### Done when

- Production runtime exports contain no fake/test provider.
- Every public export has a production cross-module consumer or names a
  deliberate public contract.
- Generic object checks occur at untrusted wire/storage/config boundaries, not
  throughout domain logic.
