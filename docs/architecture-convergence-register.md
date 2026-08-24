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
| M1 | Durable event and execution-item protocol | P0 | None | Done |
| M2 | Context manager, model capacity, and compaction | P0 | M1 lifecycle decisions | Planned |
| M3 | Tool catalog, execution policy, and permissions | P0 | M1 item decisions | In progress |
| M4 | Persistence, recovery, and keyed concurrency | P1 | M1, M3 permission terminal states | Planned |
| M5 | Provider transport, retry, and usage accounting | P1 | M2 capacity contract | Planned |
| M6 | Server lifecycle, errors, and event delivery | P1 | M1, M4 | Planned |
| M7 | GUI projections and transient state | P1 | M1 | In progress |
| M8 | Instructions, environment context, and shell discovery | P2 | M2 StepContext boundary | Done |
| M9 | Agent collaboration and Mate lifecycle | P2 | M1, M3 | In progress |
| M10 | Public module surface and test support | P3, cross-cutting | Owning modules stabilized | Planned |

Recommended execution order:

1. Establish M1's durable event and item vocabulary.
2. Rebuild M2 context capacity and M3 tool/permission ownership against it.
3. Close M4 persistence/recovery and M6 process/error lifecycles.
4. Adapt providers, GUI, instructions, and collaboration in M5/M7/M8/M9.
5. Perform M10 export and dead-surface cleanup after callers have moved.

## M1 — Durable event and execution-item protocol

Status: completed 2026-08-24.

The landed boundary follows Codex's stable item lifecycle:

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

Provider adapters keep stop reasons internal. The runner converts execution
into provider-neutral `item.started` and `item.completed` facts. Tool producers
attach semantic descriptors at the execution boundary; the kernel validates,
orders, persists, and broadcasts them without classifying raw tool names.
Reasoning has its own durable item identity. Collaboration items persist child
Session identity paired with its task path, and unknown tools use the dynamic
item variant.

The durable item union stays flat, following Codex's `TurnItem` shape. Stable
product semantics are represented directly as `command_execution`,
`file_read`, `file_search`, `file_change`, `web_fetch`, `web_search`,
`collaboration_tool_call`, and `mcp_tool_call`; runtime-defined tools use
`dynamic_tool_call`. There is deliberately no `builtin_tool_call` layer:
whether a tool is bundled is runtime provenance, not a durable domain fact.
`file_search` groups grep and glob through its operation field, while
collaboration groups spawn/message/follow-up/wait/interrupt/list through its
action field because those families share stable result and navigation data.

`file_change` records both the requested edit/write/patch operation and the
actual add/delete/update changes. An update may include a destination path to
represent a move, matching Codex's structured patch shape. Changes carry
structured unified diffs and are completed by the tool producer; GUI replay
does not recover a change by inspecting a tool name or reparsing raw output.

Completed built-in executions carry typed command, file, search, web, and MCP
results. Each runtime tool owns the mapping from its raw model-facing output
to that durable result through the finalized router; the runner only forwards
the descriptor. MCP results preserve protocol content, structured content,
error indication, and metadata instead of storing an arbitrary JSON value.

Execution items are the single durable conversation representation. The
context manager projects them into the provider-neutral, model-visible IR in
memory; GUI and API project the same items for product use. Durable history
records remain only for configuration, inherited context, and world state,
which are not execution items.

All Turn endings use `turn.completed { outcome }`; the Turn does not duplicate
a pointer to a final message because its ordered items already establish that
fact. Usage and metrics remain on the terminal event. GUI event-ID/sequence
deduplication occurs once at store ingestion, and one typed-item presenter owns
summary, detail, links, and child Session navigation.

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

Status: in progress. The finalized per-Step router and shared file-path
resolution boundary have landed; limit ownership and the remaining command /
mutation approval-policy cleanup are still open.

### Landed boundary

`ToolRegistry.finalize(enabled)` now creates the one immutable Step router.
The same selected tools produce model-visible definitions, execution
descriptors, completed-result projection, permission requirements, and
dispatch. Duplicate tool names fail when the catalog is constructed, and
disabled or unknown tools share one failure contract.

File tools accept workspace-relative paths, parent traversal, absolute paths,
and paths through symlinks. They do not receive or branch on a
workspace-boundary permission flag. One resolver canonicalizes existing
targets and the parent of new targets, supplies an execution path plus a
display path, rejects unsupported file kinds, and is re-run immediately before
compare-and-write. The current YOLO product policy relies on host-user access;
file locks, read-before-write, revision checks, bounded I/O, and symlink
revalidation remain hard safety rules.

### Confirmed problems

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

The current product default is YOLO (`never` ask), matching its single-user
coding-agent stage. Path normalization, bounded I/O, compare-and-write,
non-regular-file rejection, and command fuses are hard
safety policy and do not disappear in YOLO mode. A future interactive mode
changes only approval policy; it must not change tool schemas or path
resolution.

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

Status: in progress. Live and replay execution now share one event reducer,
event identity is deduplicated at ingestion, and one typed presenter owns tool
summary, details, file links, web links, and collaboration navigation. The
remaining model-selection and transient-state cleanup below is still open.

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

## M8 — Instructions, environment context, and shell discovery

Status: completed 2026-08-24.

### Landed boundary for models and instructions

The bundled model catalog is the only production model-directory source.
Yakitori does not fetch models.dev at runtime: the supported Codex, Grok, and
Kimi coding-agent models have explicit capabilities and instruction-profile
assignments in the catalog. An uncataloged custom model receives the generic
`default` profile; it never inherits a profile from its name or provider.

Instruction profiles describe coding-agent behavior rather than model
families. Codex, Grok, and Kimi have explicit profiles; Grok follows the Grok
Build work-policy/tool-calling direction while naming only Yakitori
capabilities. Static profiles do not advertise optional collaboration tools.
The world-state collaboration section names `spawn_agent` only when the
finalized Step exposes it.

Profiles load through packaged files only. Their content hash remains the
revision used by Session configuration and model-switch detection; the
unreachable `data:` and generic URL protocol branches are gone.

`ProjectInstructions` contains only the applicable directory and rendered
text. The world-state section owns diffing and revision fingerprints over that
model-visible representation. Source lists, duplicate revisions, and exposed
truncation metadata were removed; provenance can return when a real watcher,
trust, inspection, or multi-environment consumer exists.

### Landed macOS shell boundary

Yakitori currently targets macOS and does not maintain speculative Windows or
Linux shell-selection branches. Shell discovery ignores the parent process
`$SHELL` and resolves in this order:

```text
supported account-default path
-> zsh in PATH
-> bash in PATH
-> /bin/zsh
-> /bin/bash
-> /bin/sh
```

The existing login-shell environment probe, secret filtering, PATH merge, and
bounded process cleanup remain unchanged.

### Verified invariants

- Cataloged models use explicit instruction profiles and capabilities.
- Unknown custom models use `default` without family inference.
- Every profile is readable, cached, non-empty, and revisioned.
- Static profiles cannot mention `spawn_agent`; the dynamic world-state section
  can mention it only when the Step router exposes it.
- Project-instruction world-state compares only directory and rendered text.
- Shell tests cover account lookup, unsupported account shells, PATH lookup,
  and fixed fallbacks without reading the test process `$SHELL`.

Reference anchors:

- `.references/public/codex/codex-rs/core/src/session/multi_agents.rs`
- `.references/public/codex/codex-rs/core/src/agents_md.rs`
- `.references/public/codex/codex-rs/core/src/context/world_state/agents_md.rs`
- `.references/public/codex/codex-rs/shell-command/src/shell_detect.rs`

## M9 — Agent collaboration and Mate lifecycle

Status: in progress. Typed collaboration execution items and child Session
navigation have landed; speculative Mate lifecycle surfaces remain open.

### Confirmed problems

- Agent `pending_init` is assigned and then synchronously overwritten by
  `running` before any await, event, or caller observation.
- Collaboration tool calls now have a typed durable/UI representation; the
  remaining work is Mate lifecycle cleanup.
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

## Original finding traceability

| Original finding | Owning module |
| --- | --- |
| 1. Removed `task` still in prompts/GUI | M1, M8, M9 |
| 2. Duplicate/drifted context metadata | M2 |
| 3. Duplicated server entry/shutdown | M6 |
| 4. Three keyed Promise queues | M4 |
| 5. Falsely configurable RuntimeLimits | M3 |
| 6. SessionSummary field expansion | M4 |
| 7. Provider retry mirrors | M5 |
| 8. GUI formatting/tool maps | M1, M7 |
| 9. Repeated invalid-state checks | M6 |
| 10. Production `autoAllow` always true | M3 |
| 11. Duplicate ToolRegistry/Step dispatch | M3 |
| 12. Recovery result/stale permission gap | M4 |
| 13. Unreachable prompt URL branches | M8 |
| 14. Unconsumed resolved capacity fields | M2 |
| 15. Speculative PermissionGate clock/defaults | M3 |
| 16. GUI usage/metrics/transient fields | M7 |
| 17. Unconsumed project-instruction metadata | M8 |
| 18. Unobservable `pending_init` | M9 |
| 19. Silent EventHub listener errors | M6 |
| 20. Production-exported faux provider | M10 |
| 21. Over-broad barrels | M10 |
| 22. Dead exports/repeated generic record checks | M10 |
| GUI double sentinel | M7 |
| HTTP handlers/kernel/eventStore union | M6 |
| Speculative Mate write paths | M9 |
| Incomplete/model-insensitive context budget | M2, M5 |
| Shell discovery divergence | M8 |

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
