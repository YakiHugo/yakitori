# Architecture Convergence Register

Status: living register of confirmed architecture convergence work. This is
not an implementation specification: code, public types, and focused tests
remain authoritative. Update module status here as work lands, and move any
non-obvious surviving contract beside its owning module.

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
| M1 | Durable event and execution-item protocol | P0 | None | Planned |
| M2 | Context manager, model capacity, and compaction | P0 | M1 lifecycle decisions | Planned |
| M3 | Tool catalog, execution policy, and permissions | P0 | M1 item decisions | Planned |
| M4 | Persistence, recovery, and keyed concurrency | P1 | M1, M3 permission terminal states | Planned |
| M5 | Provider transport, retry, and usage accounting | P1 | M2 capacity contract | Planned |
| M6 | Server lifecycle, errors, and event delivery | P1 | M1, M4 | Planned |
| M7 | GUI projections and transient state | P1 | M1 | Planned |
| M8 | Instructions, environment context, and shell discovery | P2 | M2 StepContext boundary | Done |
| M9 | Agent collaboration and Mate lifecycle | P2 | M1, M3 | Planned |
| M10 | Public module surface and test support | P3, cross-cutting | Owning modules stabilized | Planned |

Recommended execution order:

1. Establish M1's durable event and item vocabulary.
2. Rebuild M2 context capacity and M3 tool/permission ownership against it.
3. Close M4 persistence/recovery and M6 process/error lifecycles.
4. Adapt providers, GUI, and collaboration in M5/M7/M9.
5. Perform M10 export and dead-surface cleanup after callers have moved.

## M1 — Durable event and execution-item protocol

### Confirmed problems

- Provider stop reasons (`tool_use`, `end_turn`), durable facts
  (`assistant.message`, `tool.call`, `tool.result`), and GUI presentation types
  are three separate representations with partially duplicated semantics.
- GUI presentation is keyed by raw tool name. The removed `task` tool still
  has a dedicated historical adapter while all current collaboration tools use
  the unknown-tool fallback.
- Tool summaries and tool details maintain separate tool-name tables.
- Durable-event deduplication happens both before and inside GUI reduction.
- Context-construction facts have been attached to assistant output metadata,
  coupling model output to request assembly.

### Target boundary

Follow Codex's stable item lifecycle:

```text
provider stream and stop reason (internal)
                  |
                runner
                  |
        turn lifecycle + item lifecycle
                  |
            durable event log
                  |
    history / session / GUI / API projections
```

Introduce a provider-neutral `ExecutionItem` union owned by the kernel, with
variants such as:

- agent message;
- reasoning;
- command execution;
- file change;
- dynamic/unknown tool call;
- collaboration-agent action.

Persist item lifecycle through `item.started` and `item.completed` (or an
equivalent paired contract). Do not add durable event types for individual
tool names. Keep streaming text, reasoning, and command-output deltas transient.
Keep model stop reasons inside provider/runner code.

Turn termination should have one explicit outcome vocabulary. Whether it is a
single `turn.finished { outcome }` event or Codex-like complete/aborted events
must be decided once in this module; GUI and recovery must not invent their
own terminal-state mapping.

Usage and Turn metrics remain durable fields on the Turn terminal event. GUI
`lastTurnUsage` and `lastTurnMetrics` are projections of that fact, not a
second persisted copy.

### Work absorbed here

- Remove the legacy `task` event/presentation path and its compatibility tests.
- Map all collaboration tools to one typed collaboration item containing child
  Session/thread identity for navigation.
- Map unknown tools to a generic dynamic-tool item.
- Make summary, detail, navigation, and model-history projection consume the
  same item union.
- Perform event-ID/sequence deduplication once at the ingestion boundary.
- Remove context diagnostics from assistant/provider metadata.

### Done when

- Adding or removing a tool does not require editing multiple GUI switch
  statements.
- A collaboration call replays with child-Session navigation without reading
  its raw tool name.
- Durable replay and live delivery produce the same item projection.
- Provider stop reasons cannot appear in the durable kernel protocol.

Reference anchors:

- `.references/public/codex/codex-rs/protocol/src/items.rs`
- `.references/public/codex/codex-rs/app-server-protocol/src/protocol/v2/item.rs`
- `.references/public/grok-build/crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/mod.rs`

## M2 — Context manager, model capacity, and compaction

### Confirmed problems

- `prunedToolResultCount` and related context metadata are constructed in more
  than one runner branch and have already drifted.
- The current cap measures `context.messages` before the complete model request
  exists. It omits or undercounts:
  - base/system instructions;
  - serialized tool definitions and JSON Schema;
  - transient inter-agent messages appended after context construction;
  - realistic image/vision cost;
  - output-token headroom.
- Text capacity uses one `4 bytes/token` approximation across models, languages,
  code, and JSON.
- A model without catalog capacity can fall back to a fixed 256 KiB budget.
- Images are replaced by small byte descriptors for local accounting even
  though provider vision-token cost can be materially larger.
- Provider-reported usage is persisted, but it is not the primary authority
  for subsequent compaction decisions.
- `ResolvedModelCapacity` exposes intermediate fields with no runtime consumer.

### Target boundary

Create one `ContextManager` that owns history normalization, selection,
tool-result truncation/pruning, compaction, fork/rollback baselines, and request
capacity accounting. A model call must obtain one immutable prepared context
from this owner.

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

Use two authorities:

- Before sending: a conservative estimator selected by model family and
  modality. It must count the exact serialized structures that the provider
  adapter will receive.
- After sending: provider-reported input/output/cache usage is authoritative
  evidence. Persist it and use it to calibrate or anchor the next compaction
  decision instead of continuing from byte estimates alone.

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

### Work absorbed here

- Remove duplicate context metadata builders and `prunedToolResultCount` from
  durable assistant/provider metadata.
- Make complete-request capacity a named result of ContextManager/Step request
  assembly rather than `messages` byte count.
- Replace the single byte/token ratio with model/modality-aware conservative
  policies without introducing a harness dependency solely for tokenization.
- Feed normalized provider usage from M5 into later compaction decisions.
- Narrow resolved Turn capacity to values actually consumed by execution;
  keep catalog maxima at catalog/validation boundaries.

### Done when

- No provider request can append unbudgeted system, tool-schema, agent, or
  image content after the capacity decision.
- Compaction tests cover text, JSON schema, multilingual/code content, images,
  output reserve, and provider-usage correction.
- Fork, rollback, resume, and compaction tests prove baseline invalidation and
  replacement semantics.
- One model call has exactly one context-selection result regardless of its
  stop reason.

Reference anchors:

- `.references/public/codex/codex-rs/core/src/context_manager/history.rs`
- `.references/public/codex/codex-rs/core/src/session/step_context.rs`
- `.references/public/codex/codex-rs/protocol/src/openai_models.rs`

## M3 — Tool catalog, execution policy, and permissions

### Confirmed problems

- `ToolRegistry` implements `get`, definitions, dispatch, and unknown-tool
  failure, then `StepToolPlan` rebuilds the same map/specs/dispatch and uses a
  different failure message.
- Model-visible specs and execution routing therefore have two potential
  owners.
- `RuntimeLimits` mixes Session semantics, per-call tool requests, and process
  safety caps. Eight tool-side keys are persisted and validated but tools read
  module constants instead.
- `RuntimeTool.autoAllow` is always true in production, leaving the permission
  request path without a real trigger.
- Permission timeout defaults and abort detection are duplicated; `now/sleep`
  dependency injection has no production caller.

### Target boundary

Follow Codex's finalized per-Step router:

```text
ToolCatalog + enabled tools + Step policy
                    |
          finalized ToolRouter
          /                  \
 model-visible specs      dispatch
```

The same finalized router must advertise and execute tools. It owns duplicate
name validation, enabled/disabled checks, argument dispatch, and the one
unknown-tool failure shape.

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

### Work absorbed here

- Replace `ToolRegistry` plus `StepToolPlan` with ToolCatalog plus finalized
  ToolRouter.
- Remove tool-side keys from persisted `runtimeLimits` through a clean schema
  break.
- Wire real approval requirements; do not delete the permission system merely
  because the current trigger is inert.
- Remove unused PermissionGate clock injection and duplicated timeout defaults.

### Done when

- The exact specs sent to the model and the exact executable tools come from
  one immutable router instance.
- A disabled or unknown tool has one tested error contract.
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

### Work absorbed here

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

### Confirmed problems

- Anthropic and OpenAI adapters duplicate retryable status sets, status detail
  extraction, and terminal error conversion.
- Retry policy is therefore maintained by manual provider synchronization.
- Provider usage is normalized and persisted but is not yet an input to M2's
  next context/compaction decision.
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

Reference anchor:

- `.references/public/codex/codex-rs/app-server/src/lib.rs`

## M7 — GUI projections and transient state

### Confirmed problems

- GUI summary/detail/navigation knowledge is split across raw tool-name maps.
- `formatDuration` and `truncateLine` have duplicate implementations.
- `modelSelectionReady` and `restoringModelSelections` represent one restore
  lifecycle through a global boolean plus a per-Session Set; the Set's extra
  granularity is not currently observable.
- Event deduplication is duplicated before and inside reduction.
- Turn usage/metrics are durable and expected to gain product consumers, while
  `streamStatus` is only connection state.

### Target boundary

GUI consumes M1's typed ExecutionItems. One item presenter provides summary,
detail, status, links, and child-Session navigation. Unknown/dynamic tools have
a complete generic presentation.

Represent model-selection restoration with one explicit status owned by the
current selection (`loading | ready | failed`) unless real concurrent
per-Session restoration creates a second consumer. Deduplicate durable events
once before reduction.

Keep usage and metrics in durable Turn facts and derive GUI selectors from
them. Keep streaming connection status transient and retain it only when UI or
reconnection logic consumes it.

### Done when

- A new tool receives generic summary/detail presentation without GUI code.
- A new typed item requires one presenter, not parallel name switches.
- Session switching cannot expose a stale model selection.
- Usage/metrics replay identically after restart.

## M9 — Agent collaboration and Mate lifecycle

### Confirmed problems

- Agent `pending_init` is assigned and then synchronously overwritten by
  `running` before any await, event, or caller observation.
- Collaboration tool calls have no typed durable/UI representation.
- `reviseMate` and `setMateLifecycle` have no production write consumer while
  Mate/Room collaboration is explicitly a later product stage.

### Target boundary

Use M1's typed collaboration item for spawn, message/follow-up, wait,
interrupt, and list activity. Child Session identity is a domain field, not a
value parsed from tool output text.

Delete `pending_init` while initialization is synchronous. Reintroduce it only
when a child Session is registered and externally visible before asynchronous
initialization completes, which is why the state is real in Codex.

Keep the smallest Mate surface required by the current single-Mate coding
agent. Preserve production-consumed create/read behavior, but remove speculative
revision/lifecycle writes and their dedicated events until Rooms supply real
owners and consumers.

### Done when

- Every exposed Agent state is observable and has a tested transition.
- Historical and live collaboration activity use the same typed item.
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

## Findings deliberately not reopened

- `runCompaction` and model-stream drain have different error and telemetry
  ownership; do not extract a shared helper without a new common contract.
- EventStore defensive cloning remains valid at its public ownership boundary.
- The validated journal-backed summary cache remains valid.
- PermissionGate's wake-and-reread loop is semantically valid; M3 may simplify
  its timer ownership without changing that loop invariant.
- Session ordering and recovery's `order: "created"` branch have real
  consumers.
- Persistence compatibility shims used only by development data may be removed
  during the planned schema break; this does not justify weakening validation
  of the new format.
