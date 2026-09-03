# Codex Divergence Register

This register tracks non-GUI boundaries where Yakitori intentionally differs
from Codex, or currently differs and still needs an explicit architecture
decision. It is not a backlog of implementation defects.

Implementation defects and unfinished convergence work belong in
`docs/architecture-convergence-register.md`. Code, public types, and focused
tests remain authoritative for behavior that has already landed.

## Comparison baseline

- Yakitori: working tree based on commit `bced04f`, including the C6 recovery,
  C3 tool-execution changes, C7 lifecycle slice, and C4 provider core recorded
  through 2026-09-03.
- Codex: `.references/public/codex` commit `536f86e5` from 2026-08-21.
- grok-build: `.references/public/grok-build` commit `19d42e35` from
  2026-08-19. It confirms the Session actor/persistence boundary, provides the
  explicit C6 coordinator alternative, and is the selected reference for C4's
  multi-wire conversation and physical-attempt boundaries where Codex is
  intentionally Responses-only.
- GUI and renderer behavior are out of scope. App-server and transport
  contracts remain in scope because they define the non-GUI host boundary.
- Legacy Codex paths are evidence about compatibility obligations, not default
  design targets for Yakitori.

Re-check a module when either baseline changes materially. Do not treat a
Codex implementation detail as a product contract unless its owning boundary,
callers, and tests establish that contract.

## Disposition labels

| Label | Meaning |
| --- | --- |
| Deliberate | An explicit Yakitori requirement already establishes the difference. |
| Open | The implementations differ, but Yakitori has not yet accepted the difference as a target contract. |
| Derived | The difference follows from another accepted decision and should not be decided independently. |
| Converge | This is an implementation gap, not a desired divergence; track the work in the convergence register. |
| Unreviewed | Only the module boundary has been inventoried. No conclusion has been reached. |

An `Open` row is not a recommendation to copy Codex or retain Yakitori. Before
implementation work crosses that boundary, record the alternatives and ask
for a product decision as required by `AGENTS.md`.

## Module audit order

The order follows ownership dependencies rather than UI visibility. A later
module may add consequences to an earlier decision, but it should not silently
change that decision.

| ID | Major module | Yakitori owners | Principal Codex owners | Status |
| --- | --- | --- | --- | --- |
| C1 | Session/Turn authority, durable protocol, persistence, and fork | `src/core/*`, legacy `src/kernel/*`, narrow recovery paths in `src/runtime/recovery.ts` | `core/session`, `core/codex_thread.rs`, `core/thread_manager.rs`, `history`, `rollout`, `thread-store` | Implemented |
| C2 | Execution loop, model context, world state, and compaction | `src/runtime/session-runner.ts`, `compaction.ts`, `model-context.ts`, `world-state.ts` | `core/session/turn.rs`, `context_manager`, `compact*`, `session/world_state.rs` | Audited |
| C3 | Tool catalog, execution, permissions, and sandboxing | `src/runtime/tools/*`, `permission-gate.ts`, `tool-permissions.ts` | `core/tools`, `tools`, `exec`, `execpolicy`, `sandboxing`, platform sandboxes | Audited; core implemented |
| C4 | Provider transport, model catalog, credentials, retry, and usage | `src/runtime/*provider.ts`, catalog and credentials modules | `model-provider`, `model-provider-info`, `models-manager`, `codex-client`, `responses_retry` | Audited; core implemented |
| C5 | Instructions, environment, shell, skills, plugins, MCP, and connectors | prompt, instruction, environment, and future extension owners | `agents_md_manager`, `context`, `skills`, `core-plugins`, `mcp`, `connectors`, `shell*` | Audited; shell/environment/instruction slices implemented |
| C6 | Subagents, AgentControl, and Mate lifecycle | `src/runtime/agent-control.ts`, `agent-runtime.ts`, multi-agent tools, `src/mates/*` | `core/agent`, `agent-graph-store`, `agent-identity`, thread spawning | Audited; core implemented |
| C7 | Process recovery, concurrency, failure reporting, and shutdown | runtime recovery/locks, server application and event hubs | core task/session lifecycle, app-server lifecycle, rollout writer recovery | Lifecycle slice audited and implemented |
| C8 | Host protocol, configuration, projects, and model discovery | `src/server/*` excluding GUI consumers | `app-server`, `app-server-protocol`, `config` | Unreviewed |
| C9 | Observability, diagnostics, history search, and operational state | currently distributed | `otel`, `diagnostics`, `analytics`, `thread-store` search/projections | Unreviewed |

## Decision summary

| ID | Boundary | Current disposition | Decision dependency |
| --- | --- | --- | --- |
| C1-D1 | Durable projection versus live Session actor as execution authority | Converge | Foundational decision accepted 2026-08-29 |
| C1-D2 | Provider-neutral normalized facts versus Responses-item rollout as canonical history | Deliberate | One rollout algebra follows Codex ownership; C4-D2 selects a tagged multi-wire representation |
| C1-D3 | Fail-closed crash-atomic kernel commits versus buffered/retried transcript persistence | Converge | Follow Codex rollout writer and ThreadStore semantics |
| C1-D4 | One strict development schema versus compatibility modes and migrations | Deliberate | No production compatibility obligation |
| C1-D5 | Input-boundary reference forks versus Codex turn/snapshot fork modes | Converge | Follow Codex; C6 verifies subagent inheritance details |
| C1-D6 | Eager startup reconciliation versus demand-driven thread resume | Converge | Derived from accepted C1-D1; durable host work remains a separate C8 decision |
| C1-D7 | One whole-Session projection versus purpose-specific live and stored projections | Converge | Derived from accepted C1-D1 |
| C1-D8 | Per-Session command serialization plus optimistic sequence checks versus actor mailbox serialization | Converge | Derived from accepted C1-D1 |
| C2-D1 | Turn-owned request settings versus one request-scoped Step snapshot | Converge | Core Step ownership implemented 2026-09-03; extension fields arrive with C5 |
| C2-D2 | Rebuild prompt from durable projection versus mutate a live ContextManager | Converge | Derived from accepted C1-D1; representation still depends on C1-D2 |
| C2-D3 | Pre-send complete-request admission versus usage-driven compaction and provider admission | Open | Reliability contract and C4 usage semantics |
| C2-D4 | Next-Turn user queue versus in-Turn steering | Converge | Follow Codex `start` / `steer` semantics |
| C2-D5 | Provider-neutral local prefix compaction versus provider-selected local/remote strategies | Open | C1-D2 and C4 provider capabilities |
| C2-D6 | Fixed per-Turn call budgets versus an unbounded tool-follow-up loop with separate rollout budget | Open | Local safety policy; C6 rollout budget |
| C2-D7 | Universal replay across model changes versus compatibility-aware pre-switch compaction | Open | C1-D2, C2-D1, and C4 model contracts |
| C3-D1 | Codex permission profiles and sandbox escalation versus unrestricted YOLO execution | Deliberate | Product requirement: the active execution mode grants full host access |
| C3-D2 | `always_approve`/`auto_file_tools` versus Codex `on-request`/`never` semantics | Deliberate | Names describe Yakitori behavior; `never` remains reserved for deny-without-asking |
| C3-D3 | Flat mutable tool maps versus typed source-aware Step routers | Converge | Follow Codex; implemented 2026-08-31 |
| C3-D4 | First-serial-call scheduling versus capability-based fair execution admission | Converge | Follow Codex runtime capability and readiness boundaries; implemented 2026-08-31 |
| C3-D5 | One-shot commands and bespoke file edits versus unified exec sessions and grammar apply_patch | Converge | Follow Codex; provider-neutral fallback is explicit; implemented 2026-08-31 |
| C3-D6 | Tool runtime hooks, MCP readiness sources, and plugin configuration | Derived | C5 owns extension discovery/configuration; C3 now exposes the required runtime readiness boundary |
| C4-D1 | Function-map dispatch versus provider, Session-client, and Turn-session owners | Converge | Follow Codex ownership and lifetime boundaries; implemented 2026-09-03 |
| C4-D2 | Responses-native history versus one tagged multi-wire conversation algebra | Deliberate | First-class Anthropic/OpenAI-compatible providers require grok-build's representation boundary; implemented 2026-09-03 |
| C4-D3 | Global static catalog lookups versus provider-scoped model managers | Converge | Follow Codex manager ownership; static managers remain the fallback when no authoritative discovery endpoint exists |
| C4-D4 | Request-local credential reads versus provider-owned live auth recovery | Converge | Follow Codex/grok-build live-auth ownership; implemented for Codex login 2026-09-03 |
| C4-D5 | Terminal-error retry versus output-aware physical attempt policy | Deliberate | Follow grok-build because multiple wire APIs share the boundary; implemented 2026-09-03 |
| C4-D6 | One accumulated usage counter versus billing and active-context semantics | Converge | Follow both references; implemented 2026-09-03; rate-limit presentation remains C8/C9 work |
| C5-D1 | Model-facing shell selection parameter versus host-owned shell detection | Converge | Codex, Claude Code, grok-build, and opencode all keep shell identity out of the model tool schema; implemented 2026-09-03 |
| C5-D2 | Env-only capture versus a login-shell snapshot sourced per exec command | Converge | Codex, Claude Code, and grok-build independently converge on snapshot plus source; cross-session snapshot reuse with TTL accepted as product decision 2026-09-03 |
| C5-D3 | Environment context content: shell identity versus sandbox/network rendering | Converge | Shell identity follows Codex/Claude Code; permission-profile and network fields are Derived from the C3-D1 YOLO decision |
| C5-D4 | Project-only AGENTS.md versus user-level plus project instruction layers | Converge | Follow Codex `$HOME`-level instructions, joined ahead of project documents |
| C5-D5 | Trust gating for project instructions | Derived | C3-D1 YOLO makes instruction text non-privileged; does not extend to future project-layer hook/MCP configuration |
| C5-D6 | MCP, skills, plugins, connectors, and user hooks | Open | Product sequencing; entry contracts already exist (C3 external registration, world-state sections) |
| C5-D7 | Single-layer user config versus a layered config stack | Open | Deferred to C8; project-scoped keys arrive with the extension work that needs them |
| C6-D1 | Process-local task registry versus one per-root AgentControl over real child Threads | Converge | Follow Codex; implemented 2026-08-31 |
| C6-D2 | Ephemeral child registry versus durable spawn topology and lazy identity restoration | Converge | Follow Codex V2 graph boundary; implemented 2026-08-31 |
| C6-D3 | Volatile mailbox completion versus retry-safe model-visible inter-agent delivery | Converge | Child Session and rollout contract; implemented 2026-08-31 |
| C6-D4 | Fresh/forked child context and bounded tree execution | Converge | Follow Codex; implemented subset excludes roles/residency |
| C6-D5 | Codex tree control versus grok-build's global task/subagent coordinator | Deliberate | Codex selected for the coding-agent harness |
| C6-D6 | Coding subagents versus persistent colleague Mates | Deliberate | Current single-Mate product boundary |
| C7-D1 | Immediate process teardown versus active-Turn drain and explicit force | Converge | Follow Codex; implemented 2026-09-02 |
| C7-D2 | Silent detached failures versus owner-local observation | Converge | Follow Codex ownership semantics through a thin Yakitori reporter; implemented 2026-09-02 |

---

## C1 — Session/Turn authority, durable protocol, persistence, and fork

Status: implemented. The live Session actor, Codex's owning module topology,
rollout representation, persistence, resume, steering, and fork semantics are
now Yakitori's runtime boundary.

### Scope and terminology

The closest identity mapping is:

| Yakitori | Closest Codex concept | Important caveat |
| --- | --- | --- |
| `SessionProjection.id` / `sessionId` | `ThreadId` | Each identifies one runnable conversation branch or agent. |
| `conversationId` | `SessionId` | Both group related runnable threads, but creation and fork grouping rules still need a dedicated C6 audit. |
| `parentSessionId` | `parent_thread_id` | Control/spawn parentage is distinct from inherited-history lineage in both systems. |
| `historyBase` | `HistoryPosition` | Both can reference a durable ancestor prefix by logical position and byte offset. |
| `TurnExecutionContext` | `TurnContext` plus step-scoped state | Codex has a richer split between Turn-wide and Step-wide configuration. C2 owns that comparison. |

Do not mechanically rename Yakitori's `Session` to `Thread` from this table.
The mapping describes roles, not a naming decision.

### Shared boundaries already aligned

These similarities do not imply that the overall architectures are the same:

- One runnable thread has at most one active Turn/task at a time.
- Canonical local history is append-only JSONL, and a trailing partial line is
  not treated as a committed record.
- Turn start, Turn termination, context/compaction facts, and selected item
  completions are durable enough to reconstruct conversation history.
- Fork lineage can refer to an immutable durable prefix instead of physically
  copying all ancestor history. Codex establishes this for paginated history;
  Yakitori uses it as its only fork storage contract.
- Summary/history projections are rebuildable from canonical JSONL. Codex's
  paginated SQLite history is explicitly a rebuildable view; Yakitori's
  `summary.json` is a validated cache.
- Live streaming deltas are not the canonical cold-replay history.

### C1-D1 — Execution authority

Disposition: **Converge; foundational decision accepted 2026-08-29.**

Yakitori's authority chain is:

```text
SessionKernel command
  -> validate current SessionProjection
  -> append one or more KernelFacts
  -> rebuild/increment SessionProjection
  -> runtime acts from the durable projection
```

`SessionKernel` exposes the complete domain mutation surface. The event store
is the source of truth for admitted input, active and terminal Turns, items,
tool results, usage, compaction, configuration, and fork lineage. The runner
re-reads this projection to choose work, and process recovery reconciles the
same projected lifecycle.

Codex's authority chain is:

```text
CodexThread submission
  -> per-Session submission loop
  -> live Session / SessionState / ActiveTurn mutation
  -> append selected RolloutItems through ThreadStore
  -> reconstruct selected history and metadata on resume
```

`ThreadManager` owns live `CodexThread` instances; `Session` owns the active
task, configuration, context manager, queues, services, and event channel.
`ThreadStore` is a storage-neutral persistence boundary, but the rollout is
not a normalized projection of every live Session invariant.

Concrete consequence: a Yakitori lifecycle mutation is invalid unless it can
be expressed and validated as a durable state transition. Codex can have
legitimate runtime state that is not a persisted rollout projection, and
resume reconstructs only the state that its history contract requires.

This choice owns the answers to C1-D3, C1-D6, C1-D7, and C1-D8. Those should
not be independently “fixed” into a hybrid architecture.

Yakitori will converge on the live actor boundary. A running Session must be
able to own legitimate process-local state without first inventing a durable
fact for it. The persisted transcript remains authoritative for recoverable
conversation history and explicit durable product state; it is not the
scheduler, lock table, or complete image of a running process.

grok-build independently confirms the same boundary. Its `SessionHandle`
sends `SessionCommand` values to a resident `SessionActor`; actor-owned
`State` contains `running_task`, `pending_inputs`, notification buffers, edit
holds, and rewindability. Pending permission/question interactions are
explicitly never persisted. A separate FIFO persistence actor owns chat and
metadata writes and exposes flush acknowledgements where a durability barrier
is actually required. The implementation is much broader than Yakitori needs,
but this ownership split agrees with Codex.

Evidence anchors:

- Yakitori: `src/kernel/session-kernel.ts`, `src/kernel/event-store.ts`,
  `src/kernel/session-projector.ts`, `src/runtime/session-runner.ts`.
- Codex: `core/src/codex_thread.rs`, `core/src/session/session.rs`,
  `core/src/session/handlers.rs`, `core/src/thread_manager.rs`,
  `thread-store/src/store.rs`.
- grok-build: `xai-grok-shell/src/session/handle.rs`,
  `acp_session.rs` (`State`, `SessionActor`),
  `acp_session_impl/run_loop.rs`, and `persistence.rs`.

### C1-D2 — Canonical persisted history representation

Disposition: **Converge on Codex's rollout item direction.**

Yakitori persists a provider-neutral normalized domain protocol:

- versioned envelopes with `id`, `sessionId`, contiguous `seq`, timestamp,
  `type`, and `data`;
- execution events for Session, Input, Turn, Item, and compaction lifecycles;
- history-only records for configuration, Turn context, world state, inherited
  context, provider-usage calibration, and aborted-turn model context;
- a provider-neutral `ModelMessage` intermediate representation for replay,
  checkpoints, and forks.

Codex persists a heterogeneous rollout protocol:

- `ResponseItemEnvelope` retains Responses-shaped model items;
- selected `EventMsg` values retain host/UI lifecycle facts;
- `TurnContext`, `WorldState`, `Compacted`, inter-agent, security, and Session
  metadata items carry harness-owned history;
- a persistence policy filters transient variants and changes the durable
  item projection between legacy and paginated history modes.

Concrete consequence: Yakitori makes cross-provider replay and kernel
validation independent of any one provider wire format, but it must explicitly
decide which provider metadata is durable and can lose semantics that are not
represented in its intermediate form. Codex keeps first-party Responses
semantics closer to the canonical transcript, at the cost of coupling history
to a larger provider/protocol item algebra.

Yakitori uses one Codex-style rollout ownership boundary but, by the explicit
C4-D2 decision, not Codex's Responses-only item type. The canonical
`ModelMessage` algebra is a tagged multi-wire superset: provider adapters retain
provider identity and opaque continuation metadata inside the corresponding
reasoning item, and may not create a second provider-native transcript beside
it. This is the minimum required difference for first-class Anthropic Messages
and OpenAI Responses transports.

The current paginated item policy was selected on 2026-08-30: `ResponseItem`
records are durable model history, terminal `ItemCompleted` snapshots are
durable host history, and `ItemStarted`, streamed deltas, and progress are
transient for every item kind, including tools and compaction. Yakitori will
not add grok-build's separate durable `updates.jsonl` protocol log.

Evidence anchors:

- Yakitori: `src/kernel/events.ts` (`KernelFact`, `ModelMessage`),
  `src/kernel/session-projector.ts`.
- Codex: `history/src/lib.rs` (`RolloutItem`, `ResponseItemEnvelope`),
  `rollout/src/policy.rs`, `protocol/src/models.rs`.

### C1-D3 — Commit, atomicity, and persistence-failure semantics

Disposition: **Converge on Codex's current rollout-writer and ThreadStore
semantics.**

Yakitori kernel commands are fail-closed around durability:

- per-Session commands validate an expected sequence;
- a multi-fact domain transition is encoded as one `fact.batch` physical JSONL
  record when `atomic: true`;
- the store writes and syncs the journal before returning success;
- append failures are propagated, the file is reopened, and committed state is
  re-read before the caller can proceed;
- startup truncates only a non-newline-terminated tail and otherwise rejects a
  malformed or non-contiguous committed log.

Codex's local rollout writer is a buffered, retrying transcript writer:

- items enter a writer queue and successful barriers flush them to JSONL;
- a failed write keeps the unwritten suffix buffered, reopens the file, and
  retries;
- paginated ordinals and projection checkpoints allow SQLite materialization
  to catch up without getting ahead of canonical JSONL;
- `Session::persist_rollout_items` logs append failures rather than turning
  every history append into a failed runtime mutation;
- the task-completion flush reports a warning when the transcript still cannot
  be saved, while the live task lifecycle can continue;
- multiple rollout items remain separate JSONL records, so recovery reasons
  about committed prefixes instead of a Yakitori-style logical fact batch.

Yakitori will adopt the Codex failure contract: the live Session may buffer,
retry, warn, and reconstruct from the committed prefix. A transcript append is
not turned into a fail-closed runtime state transition merely because the old
kernel modeled it that way. Flush/wait behavior must be copied from the owning
Codex lifecycle path—such as fork, task completion, or shutdown—rather than
adding a new universal fsync policy. A stronger barrier may be introduced only
for a documented Yakitori-specific reliability requirement.

Evidence anchors:

- Yakitori: `src/kernel/jsonl-event-store.ts`,
  `src/kernel/jsonl-event-store-format.ts`, kernel `appendMany`.
- Codex: `rollout/src/recorder.rs`, `thread-store/src/local/live_writer.rs`,
  `core/src/session/mod.rs` (`persist_rollout_items`),
  `core/src/tasks/mod.rs` (completion flush warning).

### C1-D4 — Schema evolution and compatibility

Disposition: **Deliberate.**

Yakitori currently accepts one `EVENT_SCHEMA_VERSION`, validates known fact
shapes strictly, requires contiguous sequence numbers, and has no migration
layer. A current-version unknown fact type can remain opaque and be skipped by
the projection, but an older or newer envelope version is rejected. The
project has no production users or compatibility obligation, so a clean schema
break and development-data deletion are allowed.

Codex carries real compatibility obligations:

- legacy and paginated thread-history modes coexist;
- legacy event names and item forms are mapped into newer host protocols;
- rollout migration, canonicalization, rollback replay, and read-repair paths
  preserve existing local histories;
- optional rollout ordinals distinguish older logs from paginated contracts.

Yakitori should not copy these compatibility paths unless a real obligation is
established. If Yakitori gains production histories that must survive schema
changes, this row must be reopened rather than adding ad hoc fallbacks.

Evidence anchors:

- Yakitori: `src/kernel/events.ts`, `src/kernel/event-store.ts`,
  `src/kernel/jsonl-event-store-format.ts`.
- Codex: `protocol/src/protocol.rs` (`ThreadHistoryMode`),
  `rollout/src/ordinal.rs`, `thread-store/src/local/rollout_migration*`.

### C1-D5 — Fork snapshot contract

Disposition: **Converge on Codex's current fork snapshot contract.**

Yakitori exposes one fork shape:

- the caller selects an `Input` boundary;
- the source must have no active Turn;
- source pending inputs are cancelled before the fork commits;
- the child journal records an exact ancestor `SessionHistoryPosition`
  containing Session id, exclusive sequence, and byte offset;
- the local child journal stores its own `session.created` and suffix facts;
- inherited facts are re-keyed into one contiguous child projection;
- an edit fork may admit replacement content after the inherited boundary.

Codex's current paginated fork contract has these layers:

- forks can reference a `HistoryPosition` without copying ancestor history;
- storage-level boundaries include latest, through-Turn, and before-Turn;
- core `ForkSnapshot` modes distinguish truncation before a user message from
  an interrupted snapshot that may append a `<turn_aborted>` marker;
- subagent spawning flushes the source before constructing inherited history.

Legacy history-copy behavior is a compatibility path and is not part of
Yakitori's target.

Yakitori's target is Codex's split between storage `ForkBoundary` and core
`ForkSnapshot`, including source flush and the interrupted-snapshot aborted
marker. C6 must still trace the exact subagent call path before implementation,
but it may not retain Yakitori's narrower input-only contract without a
separate explicit requirement.

Evidence anchors:

- Yakitori: `SessionKernel.forkSession`, `EventStore.forkSession`, and fork
  lineage resolution in `src/kernel/jsonl-event-store.ts`.
- Codex: `core/src/thread_manager.rs` (`ForkSnapshot`, `spawn_subagent`),
  `thread-store/src/types.rs` (`ForkBoundary`),
  `thread-store/src/local/paginated_fork.rs`.

### C1-D6 — Process-loss recovery boundary

Disposition: **Converge on demand-driven resume; detailed shutdown and host
queue behavior remains coupled to C7/C8.**

Yakitori performs eager store-wide reconciliation when the application starts.
It lists every Session, durably interrupts any projected active Turn with a
runtime-loss reason, then wakes Sessions with durable pending input. This is a
semantic recovery pass over the event-sourced lifecycle, not merely log repair.

Codex core resumes a selected thread by loading rollout history and spawning a
new live `Session`. Reconstruction handles persisted Turn markers, context,
usage, rollback, compaction, and incomplete-history cases, but `ThreadManager`
does not make every stored thread live and reconcile every one at process
startup. Rollout writer and SQLite read-repair are separate storage recovery
concerns.

Concrete consequence: Yakitori can make “admitted input eventually runs after
restart” a store-wide server guarantee. Codex's core boundary is
thread-activation and resume oriented; any durable host queue is a separate
app-server/thread-store concern and must be examined in C8.

The accepted actor decision removes that guarantee from the Session core.
Resuming a selected Session reconstructs conversation and explicit durable
settings, then creates fresh operational state. It does not scan all Sessions,
recreate their input queues, or automatically execute work that existed only
in a dead process. If Yakitori later needs accepted background work to survive
a restart, that belongs to a separately named durable job/admission owner at
the host boundary, not to transcript replay.

Evidence anchors:

- Yakitori: `src/runtime/recovery.ts`.
- Codex: `core/src/thread_manager.rs` resume paths,
  `core/src/session/rollout_reconstruction*`, `thread-store` repair paths.

### C1-D7 — Projection ownership

Disposition: **Converge; derived from accepted C1-D1.**

Yakitori has one whole-Session `SessionProjection` derived from the complete
fact lineage. It is used for runtime validation, scheduling, API detail, usage,
items, tools, and recovery. `summary.json` is only a list optimization and is
validated against journal length.

Codex deliberately uses purpose-specific state:

- live `SessionState` and `ContextManager` for execution;
- rollout reconstruction for model-visible history and selected settings;
- app-server thread-history projection for host DTOs;
- SQLite materialization for paginated listing, paging, search, and lineage;
- thread metadata/state stores for operational features outside the rollout.

Yakitori must remove `SessionProjection` from the execution path. Stored
history, list summaries, and live status should be purpose-specific views.
Retaining a mandatory whole-Session projection behind the actor would preserve
the old architecture under a new API.

### C1-D8 — Mutation serialization

Disposition: **Converge; derived from accepted C1-D1.**

Yakitori serializes kernel commands per Session in process, serializes store
writes per Session, and still supplies `expectedSeq` to reject stale
read/validate/append cycles. Cross-session fork/delete graph mutations add a
separate graph gate and ordered per-Session acquisition.

Codex serializes external thread operations through a bounded submission
channel and lets the live Session coordinate task, queue, and configuration
state with owned locks and cancellation tokens. The local `ThreadStore` has
writer/lifecycle locks for persistence and lineage operations rather than a
domain-wide optimistic sequence contract.

Both prevent two active Turns in one runnable thread. The difference is where
serialization belongs: durable aggregate commands in Yakitori, live actor
mailbox in Codex.

Yakitori will serialize Session operations at the actor mailbox. Storage keeps
only the synchronization required for ordered appends, flush, fork, deletion,
and metadata updates. `expectedSeq` must no longer be a domain precondition for
starting a Turn, cancelling work, resolving permission, or accepting a steer.

### Selected reference architecture

Codex is the selected implementation reference for this boundary. Yakitori
must preserve the same ownership topology instead of synthesizing a new
`SessionActor`/`SessionHandle` architecture from multiple projects:

```text
ThreadManager
  -> owns live Arc<CodexThread> entries and ThreadStore
  -> create / resume / fork

CodexThread
  -> Arc<Session>
  -> SessionIo
       - bounded submission sender
       - event receiver
       - status / termination conduits

Session submission loop
  -> receives Op
  -> mutates the live Session / SessionState
  -> owns at most one active task and Turn-local input
  -> emits Event values
  -> persists selected RolloutItem values through ThreadStore

ThreadStore
  -> create / resume / append / flush / fork / read / list / delete
  -> canonical JSONL rollout plus rebuildable stored projections
```

Yakitori may retain public `sessionId` naming to avoid an unrelated API rename,
but its internal owners must map one-to-one to these Codex responsibilities.
Any different topology needs a concrete Yakitori constraint recorded at the
owning boundary before implementation.

| Codex owner to follow | Yakitori responsibility |
| --- | --- |
| `ThreadManager` | Registry of resident runnable conversations; create, resume, fork, lookup, removal, and store ownership |
| `CodexThread` | Public conduit that couples one live `Session` with its `SessionIo`; it does not own a second state machine |
| `SessionIo` | Bounded submission channel, event delivery, status, and termination coordination |
| `Session` / `SessionState` | Live configuration, context, active task, Turn-local queues, cancellation, services, tools, and subagent control |
| `ContextManager` | The single live model-visible history owner, including normalization, rollback, and compaction replacement |
| `ThreadStore` / rollout writer | Ordered rollout persistence, resume reconstruction, flush, fork lineage, listing projections, and storage repair |

C1 does not independently choose a provider-neutral replacement for Codex's
`RolloutItem`/`ResponseItem` history algebra. Yakitori's existing multi-provider
support is a concrete reason C1-D2 may require a different item representation,
but C4 must identify the exact required difference. It may change the item
algebra; it may not change the Session/ThreadStore ownership architecture.

#### State classification

Keep process-local unless a separate product requirement says otherwise:

- active task/Turn and its abort controller;
- pending input, steer, notification, and inter-agent delivery queues;
- permission/question waiters and timeouts;
- streamed reasoning/assistant accumulators and coalescing state;
- tool execution handles, retry/failure counters, telemetry spans, and actor
  worker state;
- compaction-in-progress state and subagent waiters.

Persist because resume, history, fork, or a user-visible product feature needs
it:

- Session identity, lineage, creation metadata, and resumable configuration;
- user/model-visible messages, assistant content, tool calls, and tool results;
- Turn context needed to interpret/replay history and terminal/aborted markers
  needed by the transcript contract;
- compaction replacement/checkpoint identity and world-state baselines;
- usage totals only where they are an exposed accounting/history contract;
- explicit durable goal/plan/job state, when such a feature has its own
  lifecycle contract.

Do not persist `pending`, `running`, `requested`, or `in progress` merely so a
projection can recreate the process. A tool call may still be persisted before
its side effect as transcript evidence; that does not make an `activeTool`
projection the runtime authority.

#### Selected persistence semantics

Yakitori follows Codex's buffered, retrying rollout writer and its existing
lifecycle-specific flush behavior. Persistence failure does not recreate a
fail-closed kernel command boundary. Fork, task completion, shutdown, and
resume must use the same barriers and committed-prefix recovery semantics as
their Codex owners.

A stronger prompt or pre-tool-side-effect durability barrier is not part of
the target by default. Adding one requires a concrete Yakitori reliability
requirement and a review of how that deviation affects cancellation, crash
recovery, and non-idempotent tool calls.

### C1 downstream C4 boundary

The authority, persistence, and fork architecture follows Codex. The remaining
C1-linked decision is whether exact provider-native response history is
required for retry/resume or Yakitori needs a provider-neutral rollout item
algebra. C4 owns that decision because multi-provider support is the concrete
reason a deviation may be necessary. It does not keep C1 open.

New cross-module abstractions must assume live actor authority. They must not
add new `KernelFact` variants for transient execution state or introduce a
second mutable history beside the actor-owned `ContextManager`.

---

## C2 — Execution loop, model context, world state, and compaction

Status: audited against the comparison baseline. Provider-specific transport
details remain deferred to C4, and skills/MCP section content remains deferred
to C5.

### Shared execution shape

Both implementations follow the same high-level coding-agent loop:

```text
capture Turn-wide configuration
  -> capture one request-scoped Step
  -> update model-visible dynamic context
  -> build and send a model request
  -> persist assistant/tool-call history
  -> execute tools
  -> append tool results
  -> capture a new Step and sample again, or finish the Turn
```

Both also establish these narrower contracts:

- The advertised tool definitions and the router that executes returned calls
  come from the same Step snapshot.
- Dynamic environment/instruction state is captured again between sampling
  requests and represented as model-visible context updates.
- Tool call/output pairs are normalized before a prompt is sent.
- Images are adapted to the selected model's input modalities.
- Compaction replaces model-visible history while the complete transcript
  remains durable.
- Compaction establishes a new context-window identity and a new world-state
  baseline.

The remaining differences concern how much a Step may change, where prompt
history lives, how admission is decided, and which compaction implementation
owns replacement history.

### C2-D1 — Turn-owned settings versus a Step-owned request snapshot

Disposition: **Converge on Codex; core implemented.**

Codex captures one `StepContext` after pending input has been drained and
before each logical model sampling request. That Step owns:

- concrete `ModelInfo`, reasoning effort/summary, and service tier;
- approval policy and approval reviewer after model-specific constraints;
- environment snapshot and selected capability roots;
- MCP binding and executor capability discovery;
- finalized tool router;
- the observed AGENTS.md value;
- model-attributed telemetry.

Codex retains legacy model fields on `TurnContext`, but step execution reads
the corresponding `StepContext` fields. A physical retry reuses the same Step;
it does not recapture tools or policy. Ordinary user model-setting changes are
still admitted for the next Turn: request-scoped ownership must not be confused
with changing the active Turn's model after every steering input. Alternate
model contexts used by compaction and model-switch paths can nevertheless pass
their own concrete model through the same Turn-scoped transport session.

Yakitori now follows that shape for its implemented surface. The Turn keeps
its initial attribution and total call counters. After steering input is
recorded, every sampling iteration captures one immutable `StepContext`
containing the concrete target and model metadata, context capacity and
derived execution limits, approval policy, enabled-tool eligibility, wire
protocol, and finalized router. Request construction, image adaptation,
admission and compaction, response attribution, approval, and tool execution
all consume that same Step. Project instructions, environment, world state,
and multi-agent context are observed in the same iteration before the request
is sent.

The active Turn's selected model remains stable, matching Codex. A steered
model selection is persisted as Session configuration for later Turns. MCP,
approval-reviewer, service-tier, executor-capability, and telemetry fields do
not yet have Yakitori product implementations; when added under C5/C9, they
must extend this Step rather than create another request owner.

Evidence anchors:

- Yakitori: `src/runtime/session-configuration.ts`,
  `src/runtime/tools/spec-plan.ts`, and the sampling loop in
  `src/runtime/turn-processor.ts`.
- Codex: `core/src/session/turn_context.rs`,
  `core/src/session/step_context.rs`, Step capture in
  `core/src/session/mod.rs` and `core/src/session/turn.rs`.

### C2-D2 — Prompt-history owner

Disposition: **Derived from C1-D1 and C1-D2.**

Yakitori reconstructs model history from `SessionProjection` for every Step.
`buildModelContext` groups inherited history, the latest checkpoint, completed
Turns, fork context, and the active Turn. It then applies tool-result
truncation/pruning and selects an admissible history without mutating the
durable transcript.

Codex mutates a live `ContextManager` as Responses items arrive. A request
clones that history, normalizes it for the model's modalities, repairs paired
items, and sends the resulting `ResponseItem` sequence. Compaction and rollback
replace or trim the live history and increment a history version.

This is the context-layer manifestation of C1-D1. Keeping Yakitori's durable
projection authority while introducing a second mutable conversation history
would require continuous synchronization and create ambiguous recovery. If
C1-D1 remains, a cache may optimize `buildModelContext`, but it must be
discardable and provably keyed to a durable sequence/window.

Evidence anchors:

- Yakitori: `src/runtime/model-context.ts`.
- Codex: `core/src/context_manager/history.rs`,
  `core/src/context_manager/normalize.rs`.

### C2-D3 — Context admission and compaction trigger

Disposition: **Open; a reliability contract, not an accuracy contest.**

Yakitori has two explicit stages:

1. History selection applies message-block and serialized-byte caps. Old tool
   results are truncated and then pruned before complete Turn groups become
   compaction candidates.
2. After system sections, messages, agent additions, image adaptation, and
   tool schemas are assembled, `estimateModelRequestBudget` estimates the
   complete request plus reserved output capacity. A matching provider-usage
   baseline may calibrate an unchanged request prefix. The runner compacts or
   rejects before sending when the effective model window would be exceeded.

Codex tracks provider-reported active-context usage, an optional auto-compact
scope, context-window limits, and estimated history tokens. It compacts before
a Turn when prior usage/model switching requires it, and after a sampling
request when follow-up work would cross the token limit. The current
`run_turn` source explicitly notes that pre-Turn compaction does not yet
estimate the pending context updates and fresh user input.

Concrete consequence: Yakitori may reject an estimated request that a provider
would have accepted, but it does not intentionally send a known-over-budget
complete request. Codex uses stronger provider evidence for the prior active
context and can rely on provider admission for the newly assembled request.
These are different failure semantics; tokenizer accuracy alone does not
settle the choice.

The Yakitori `4 UTF-8 bytes/token` formula, image estimates, and output reserve
are implementation safety estimates, not Codex or provider quotas. Catalog
capacity still needs an authoritative source under C4.

Evidence anchors:

- Yakitori: `src/runtime/model-context.ts`,
  `src/runtime/model-request-budget.ts`, request assembly and pre-send checks
  in `src/runtime/session-runner.ts`.
- Codex: `core/src/session/context_window.rs`,
  `core/src/context_manager/history.rs`, pre/post sampling compaction in
  `core/src/session/turn.rs`.

### C2-D4 — User input while a Turn is active

Disposition: **Open; product-visible even though GUI is out of scope.**

Yakitori durably admits every normal user message as an `Input`. If a Turn is
already active, the new Input remains in `pendingInputs`; the per-Session lane
starts it as a new Turn only after the active Turn reaches a terminal state.
The active loop can receive special inter-agent additions between model calls,
but ordinary user input is not drained into that Turn.

Codex supports explicit Turn-input modes. A steer submitted while a regular
Turn is active enters its Turn-local pending input, is persisted into history
after the current sampling/tool boundary, and can cause the same Turn to take a
follow-up sample. Mailbox delivery has separate current-Turn/next-Turn rules.

Concrete trigger: while a command/tool chain is running, the user sends “stop
editing that file; inspect the logs instead.” Yakitori schedules a later Turn
unless the user also interrupts; Codex can steer the active Turn at the next
sampling boundary. This changes Turn identity, cancellation, usage attribution,
and fork boundaries, so it is not a GUI-only feature.

Evidence anchors:

- Yakitori: `SessionRunner.runLane`, `SessionKernel.admitInput`.
- Codex: `protocol/src/turn_input.rs`, `core/src/session/input_queue.rs`,
  pending-input handling in `core/src/session/turn.rs`.

### C2-D5 — Compaction implementation and replacement contract

Disposition: **Open; coupled to provider capabilities in C4.**

Yakitori currently has one provider-neutral compaction implementation:

- summarize a continuous oldest history prefix at complete group boundaries;
- use the active model through the ordinary provider-neutral `ModelRequest`;
- split into two passes when the source cannot fit, or reduce the oldest
  eligible prefix after overflow;
- reject a replacement whose estimated future token cost is not smaller;
- cap the summary with a local byte safety boundary;
- atomically persist checkpoint coverage, exact replacement `ModelMessage`
  history, world-state baseline, usage, and compaction-item completion;
- retain the previous checkpoint when compaction fails, with a per-Session
  failure circuit breaker.

Codex selects among multiple implementations:

- local summarization;
- remote compaction variants when the provider supports them;
- token-budget-specific context-window rollover;
- manual, pre-Turn, mid-Turn, model-downshift, and comp-hash-change triggers;
- optional reinjection of initial context before the last real user message for
  inline compaction;
- a replacement `ResponseItem` history plus `CompactedItem`, window ids,
  world-state baseline, and reference `TurnContextItem`.

Codex local compaction deliberately retains collected user messages alongside
the summary. Yakitori's checkpoint prompt asks the model to reproduce user
messages inside one summary and replaces the covered prefix with that summary
plus current world-state fragments. These are materially different model
history contracts.

Remote compaction cannot be added as a thin alternative `compact()` function:
the provider may own the replacement item shape, retained-message policy,
usage, and continuation semantics. C1-D2 and C4 must first decide whether that
provider-native result can become canonical Yakitori history.

Evidence anchors:

- Yakitori: `src/runtime/compaction.ts`, `attemptCompaction` and
  `executeCompactTurn` in `src/runtime/session-runner.ts`,
  `SessionKernel.recordCompaction`.
- Codex: `core/src/compact.rs`, `compact_remote.rs`,
  `compact_remote_v2.rs`, `compact_token_budget.rs`,
  `Session::replace_compacted_history`.

### C2-D6 — Bounded Turn work

Disposition: **Open; the current numbers are local safety boundaries.**

Yakitori persists Session execution defaults and freezes concrete Turn limits.
The defaults stop a Turn after 16 model calls or 32 tool calls, and separately
bound model-visible blocks/bytes, tool-result content, compaction summaries,
and assistant output. Exceeding a call budget durably fails the Turn.

Codex's ordinary model/tool follow-up loop does not expose equivalent fixed
per-Turn model-call and tool-call quotas. It has targeted safety caps, output
truncation, context limits, rate limits, and an optional rollout token budget
whose scope includes multi-agent work, but those are different contracts.

The Yakitori defaults must be described as locally selected resource-safety
limits, never as product or provider quotas. Before accepting the divergence,
the owner must document the concrete runaway/fairness scenario each persisted
Session preference prevents and why the limit belongs in durable Session
configuration rather than process policy.

Evidence anchors:

- Yakitori: `src/runtime/limits.ts`, `TurnExecutionLimits`, and loop guards in
  `SessionRunner.executeTextTurn`.
- Codex: `core/src/session/turn.rs`, `core/src/rollout_budget.rs`,
  `core/src/session/rollout_budget.rs`.

### C2-D7 — Model-switch compatibility

Disposition: **Open; coupled to C1-D2, C2-D1, and C4.**

Yakitori lets each admitted Input select a provider/model. The next Turn
rebuilds provider-neutral history and uses the new model's instruction profile
and context capacity. It has no persisted compaction-compatibility hash and no
special pre-switch compaction using the previous model.

Codex records previous model settings and may compact before the new Turn when:

- old and new models expose different compaction compatibility hashes; or
- the new model has a smaller context window and current usage no longer fits.

When supported, it attempts compaction with the previous model and can capture
a current-model fallback Step. This treats some model histories as not safely
interchangeable even when their item schema is shared.

Yakitori's universal provider-neutral replay is therefore a stronger promise
than Codex makes. C4 must establish whether provider/model adapters guarantee
semantic replay of reasoning, tool calls, images, and compaction checkpoints,
or whether Yakitori also needs an explicit compatibility boundary.

### World-state mechanism — aligned

No divergence decision is currently required for the mechanism itself. Both
systems:

- build dynamic model-visible state from the exact Step used for tools;
- diff it against the last model-visible baseline;
- append rendered contextual messages before persisting the corresponding
  structured state patch;
- retain a reference Turn-context baseline for later diffs;
- reset or fully establish baselines across compaction and truncated history.

Yakitori's rollout preserves the explicit full-versus-patch marker, live state
retains the complete snapshot rather than the last patch, reconstruction
applies patches chronologically, and compaction establishes a new full
baseline. Merge creation, application, and structural JSON equality share one
owner. The breadth of world-state sections—MCP, plugins, permissions,
collaboration, environments, and model messages—belongs to C3/C5/C6.

### C2 follow-up decisions

Before changing the execution loop across module boundaries, decide:

1. Can model/provider/approval/tool capability change between samples in one
   Turn, or is a Turn the durable immutable execution-policy unit?
2. Is ordinary mid-Turn user steering required, and at which persisted
   sampling boundary does it become model-visible?
3. Is pre-send complete-request rejection part of Yakitori's reliability
   promise even when it uses conservative estimates?
4. Must provider-native remote compaction be supported, and if so, who owns its
   replacement history contract?
5. Are per-Turn model/tool call counts durable user/session policy or
   process-local runaway protection?
6. Which model/provider changes require compaction rather than direct replay?

---

## C3 — Tool catalog, execution, permissions, and sandboxing

Status: audited. The core tool identity, dispatch, execution-ordering, command,
and patch boundaries follow Codex. Unrestricted execution remains an explicit
Yakitori product decision rather than an unfinished sandbox implementation.

### First-principles problem

A model tool call crosses four independent contracts:

1. catalog identity: the definition shown to the model must name exactly the
   runtime that will receive the call;
2. admission: approval and readiness waits must finish without occupying an
   execution slot or letting later calls cross a serial barrier;
3. execution: concurrent observations may overlap, while mutations and opaque
   effects need a fair global ordering boundary;
4. evidence: outputs, file revisions, partial side effects, process sessions,
   and provider replay must remain truthful after the current Step ends.

A flat `Map<string, handler>` does not establish those contracts. In
particular, a catalog refresh can change the meaning of a name after the model
saw it, a pending mutation can be overtaken by later reads, and a failed
multi-file patch can modify disk while reporting no durable delta.

### Adopted Codex boundaries

- `ToolName` owns structured namespace identity and one injective canonical
  model-facing name. Trusted and external registration are different APIs;
  reserved names, namespace ownership, first collision, exposure, and search
  metadata are decided before a Step is finalized.
- A finalized `ToolRouter` is the Step snapshot for definitions, exposure,
  source, search, runtime identity, parallel capability, approval, readiness,
  and execution. Definition and search metadata are cloned and frozen; later
  extension mutation affects only a later Step.
- Each call reserves the Session-owned fair read/write execution gate in model order.
  Permission and runtime readiness waits occur before the reservation takes its
  execution lock. A waiting writer remains a barrier, so later ready readers
  cannot overtake it; earlier admitted readers can finish.
- `exec_command` and `write_stdin` share a Session-owned process manager. PTY
  and pipe processes support bounded initial yield, continued polling,
  incremental drain-only output, queued interaction, cancellation, process
  groups, timeout, and soft-cap LRU cleanup.
- Model metadata selects file-editing capability independently of the Provider
  wire protocol. Codex-capable models receive the grammar `apply_patch` tool;
  function-oriented model families receive their own structured edit/write
  tools instead. A durable custom-call item retains its fallback property, so
  historical cross-provider replay never reconstructs it from the current
  Step's tool set.
- Patch execution follows Codex parsing and file semantics: lenient markers,
  ordered contexts, EOF additions, mixed line-ending preservation, Add/Move
  overwrite, missing destination parents, resolved-path duplicate rejection,
  and cumulative partial-failure delta. Multi-file revision grants, deletion
  tombstones, and inexact invalidation survive into later model Steps.

### Deliberate YOLO permission difference

Yakitori does not compile Codex `PermissionProfile` filesystem/network
capabilities and does not invoke platform sandboxes. The active product mode is
unrestricted host execution: inherited environment, arbitrary command cwd,
filesystem access, network access, and child processes have the host user's
authority. Process time/output caps, binary-output checks, process-group
termination, credential-like environment filtering, and catastrophic-command
fuses remain operational safety boundaries; they are not described as a
sandbox or security boundary.

The approval vocabulary therefore names actual behavior:

- `always_approve`: execute admitted tool calls without asking;
- `auto_file_tools`: file changes proceed automatically while command
  execution can ask through the permission gate.

The name `never` is not used for full access. It remains available for the
Codex meaning “never ask and never escalate,” should Yakitori later add bounded
profiles. This keeps product mode names separate from runtime capabilities and
avoids silently changing the meaning of a stored policy.

### Extension boundary

Concrete MCP/plugin discovery, connection ownership, configuration trust, and
user-configured Pre/PostToolUse hooks belong to C5. C3 already supplies the
runtime contracts they need: external registration, deferred exposure, Step
snapshotting, tool-owned readiness, fair admission, explicit fallback
adaptation, and registry disposal. A future extension must enter through those
contracts; it must not mutate an active Step or run an alternate dispatch loop.

Grok-build confirms the need for Session-owned execution state and durable
tool evidence, but Codex is the selected reference for catalog identity,
fair parallel dispatch, process sessions, and patch behavior.

---

## C4 — Provider transport, models, credentials, retry, and usage

Status: audited and core implementation completed. Codex is the selected
reference for provider ownership and Session/Turn transport lifetimes.
grok-build is the selected reference only where Yakitori's explicit
first-class multi-provider requirement makes Codex's Responses-only boundary
inapplicable: conversation wire conversion and physical-attempt retry.

### C4-D1 — Provider and transport ownership

Disposition: **Converge on Codex; implemented.**

Codex has a process-scoped `ModelProvider`, a Session-scoped `ModelClient`, and
a Turn-scoped `ModelClientSession`. Yakitori now has the same ownership shape.
`ProviderRegistry` owns provider objects rather than only a string-to-function
map. Each live Session obtains one routing `ModelClient`; it retains the
provider clients used by that Session, while every Turn gets one transport
session and independent retry state. Like Codex, that session is not bound to
the complete model target: each Step passes its concrete model settings to the
stream request. The compatibility `StreamFn` port remains only for focused
tests and injected transports; the application production path uses the owned
clients.

Yakitori's Session-level routing client selects one provider client when each
Turn starts. The resulting provider Turn session accepts request-specific
models but rejects another provider, so sticky state cannot cross provider
boundaries. Selecting providers between Turns is the required multi-provider
difference from Codex's normally stable provider client, not a second
orchestration owner. `Session` and `TurnProcessor` continue to own the agent
loop.

Turn cleanup is explicit on normal completion and abort. The routing
`ModelClient` also tracks outstanding Turn sessions so Session shutdown closes
them before provider clients; both paths are idempotent under abort/finally
races.

### C4-D2 — Canonical conversation and wire conversion

Disposition: **Deliberate multi-provider difference; follow grok-build's
tagged-superset boundary.**

Codex persists Responses-native items. That is exact for its selected wire but
would make Anthropic Messages a lossy compatibility adapter. Yakitori instead
keeps one durable `ModelMessage` algebra and provider-specific converters, as
grok-build does. Opaque reasoning continuation data now records both the
provider identity and issuing backend/account scope. An adapter may replay
that continuation only when both match; a matching wire protocol or provider
name alone is insufficient because IDs, signatures, and encrypted content
belong to one service account/backend. Codex derives the stable scope from its
account ID. Generic API-key providers derive a stable, domain-separated digest
from provider ID, endpoint, and credential identity; the credential itself is
never persisted. Grok CLI login uses the same rule with its current access
token because its shared login exposes no stable account identity. Legacy
untagged metadata is accepted only by direct legacy adapter calls without an
active scope, never by the production provider owner.

There is still no parallel provider-native transcript. Incompatible reasoning
is omitted from the new provider request while ordinary assistant text and
tool history remain replayable. C2-D7 remains open because deciding whether a
model switch must compact or may discard incompatible continuation state is a
separate product behavior.

### C4-D3 — Model manager ownership

Disposition: **Converge on Codex's manager boundary; core implemented with
static managers.**

Every registered provider now owns one `ModelsManager`. Session configuration,
Turn resolution, context capacity, and the server model directory consult that
same manager rather than independently reading the bundled catalog. Providers
without a first-party capability-discovery response use a provider-scoped
static manager backed by the bundled fallback, matching Codex's static-manager
variant.

Yakitori does not fabricate remote capability metadata from a generic
`/models` list. Codex's authenticated models endpoint returns Codex-specific
metadata and ETags; the registered Anthropic, Kimi, and xAI endpoints do not
establish one common authoritative payload. Remote refresh/cache/ETag support
should be added to an individual provider manager only with that provider's
first-party contract. Host-facing refresh and presentation remain part of C8.

### C4-D4 — Credential freshness and unauthorized recovery

Disposition: **Converge on live provider-owned auth; implemented for Codex.**

The Codex ChatGPT provider now owns a live auth resolver. It re-reads the
shared CLI login so external rotation is visible and single-flights stale
refresh. Like Codex, it treats refresh as a mutation of the owning credential
source: Yakitori refreshers serialize through a cross-process file lock,
perform a guarded reload under that lock, and atomically persist the replacement
access token, rotated refresh token, optional ID token, and `last_refresh`
before returning the new access token. A pre-output HTTP 401 permits exactly
one forced refresh attempt. Recovery is fenced to the initiating account;
same-account external rotation wins through guarded reload, while an account
change terminates recovery without resending the request. Token material is
never included in errors.

The Grok CLI login remains read-only and fails closed near expiry. This is a
necessary difference: its shared token family can rotate during refresh, and
Yakitori does not own the CLI credential file or an authoritative locking
protocol. `XAI_API_KEY` remains the provider-owned non-refreshing alternative.

### C4-D5 — Retry and logical-output integrity

Disposition: **Follow grok-build's physical-attempt contract; implemented.**

SDK retries remain disabled. The provider layer classifies errors; the
Turn-scoped request runtime applies the bounded policy. A retryable terminal
may be hidden and retried only before any snapshot has become externally
visible. Once text or reasoning output is observed, the error is returned to
the Session rather than merging a second physical attempt into the same live
item. Rate limits use grok-build's smaller two-attempt budget and honor the
full provider `Retry-After` hint after a separate 120-second parser safety
bound; other transient failures retain the generic backoff ceiling. A stream
that emits no event for 300 seconds is aborted and terminated as an idle
timeout. Cancellation still terminates both streaming and backoff immediately.

### C4-D6 — Usage and request correlation

Disposition: **Converge on separated semantics; implemented core.**

Provider usage now distinguishes accumulated billing counters from the active
model-visible context reported for the latest response. Billing input/output
and cache counters sum across calls; `activeContextTokens` is replaced by the
latest reported input-plus-output context value. xAI Responses uses its
provider-specific `context_details` counters when present; Anthropic includes
cache-read, cache-created, current input, and current output tokens; OpenAI and
Codex use the response total. Both semantics survive Turn completion and
server projection.
Provider request IDs are retained on the durable assistant envelope so an
observed response can be correlated with provider diagnostics.

Rate-limit/account quota snapshots are not inferred from token usage. Current
SDK transports do not expose one stable cross-provider event contract, so C8
and C9 must add provider-specific snapshots when they add host presentation and
diagnostics rather than overloading `TokenUsage`.

Evidence anchors:

- Yakitori: `src/runtime/model-provider.ts`, `models-manager.ts`,
  `provider-registry.ts`, `retrying-stream.ts`, `codex-credentials.ts`,
  `codex-provider.ts`, `openai-provider.ts`, `anthropic-provider.ts`, and
  `turn-processor.ts`.
- Codex: `model-provider-info/src/lib.rs`, `model-provider/src/provider.rs`,
  `models-manager/src/manager.rs`, `core/src/client.rs`, and
  `core/src/responses_retry.rs`.
- grok-build: `xai-grok-sampler/src/config.rs`, `actor/request_task.rs`,
  `retry.rs`, and `xai-grok-sampling-types/src/conversation.rs`.

---

## C5 — Instructions, environment, shell, and the extension surface

Status: audited for the instruction, environment, and shell boundaries.
MCP, skills, plugins, connectors, and user hooks are recorded as Open product
decisions; their runtime entry contracts already exist (C3 external tool
registration, Step-snapshotted routers, and world-state sections) and no
extension may bypass them.

### First-principles problem

Beyond the conversation, each model call sees a world made of three kinds of
state, each with its own contract:

1. authority: instruction text from layered sources (base prompt, user-level,
   project-level) must compose at unambiguous scopes, and low-trust content
   must not gain authority;
2. freshness versus per-Step consistency: AGENTS.md edits and environment
   changes arrive mid-session, but one model call must observe one coherent
   snapshot, and durable history must record what the model actually saw;
3. host reality: exec commands are interpreted by a concrete shell whose
   identity and startup state the model cannot supply; the harness owns that
   contract.

Yakitori already has the unifying mechanism for (1) and (2): world-state
sections snapshotted per Step, diffed via RFC 7386 merge patch, persisted as
`world_state` rollout items, and rebuilt on resume
(`src/runtime/world-state.ts`, `src/core/context-manager.ts`). C5 attaches
further state to that spine rather than adding parallel mechanisms.

### C5-D1 — Model-facing shell selection

Disposition: **Converge; implemented 2026-09-03.**

Codex, Claude Code, grok-build, and opencode all keep shell identity out of
the model-facing tool schema: the shell is a host deployment fact, detected
once by the harness (account shell, PATH candidates, fixed fallbacks), with
operator overrides living in env vars or config behind basename whitelists or
deny-lists. Claude Code exposes PowerShell as a separate tool rather than a
parameter.

Yakitori's `exec_command` previously accepted a model-supplied `shell` string
that passed unvalidated into `spawn`; any unrecognized name silently received
POSIX `-c` semantics, so `shell: "fish"` executed with wrong syntax semantics
instead of producing an input error. The parameter is removed; shell identity
is host-owned. This is a contract fix, not a security boundary — under YOLO
the model can already run arbitrary commands.

### C5-D2 — Shell state for exec commands

Disposition: **Converge on snapshot replay; cross-session reuse accepted
2026-09-03.**

Codex, Claude Code, and grok-build independently converge on one design:
capture the login shell's state once, persist it as a script, and source that
script in each fresh non-login `-c` command. An `env`-only capture (Yakitori's
previous behavior, also opencode's) carries environment variables but cannot
carry aliases or shell functions, so model commands referencing them fail with
uninformative `command not found` errors. The snapshot additionally forces
alias expansion in non-interactive shells, and commands run through `eval`
because alias expansion requires a second parse pass after sourcing.

Yakitori decision: generate the snapshot once, cache it across sessions under
the Yakitori home directory, and expire snapshots older than three days
(product decision: local shell environments are stable enough that the
startup cost of per-session regeneration is not worth paying; Codex uses the
same three-day retention). Snapshot failure degrades to the previous env-probe
plus plain `-c` behavior.

### C5-D3 — Environment context content

Disposition: **Converge for shell identity; Derived for the rest.**

The model must know which shell interprets its commands; Codex and Claude
Code both render shell identity into the environment context. Yakitori adds
the detected shell basename to `EnvironmentSnapshot`. Codex's network and
filesystem permission-profile fields exist to communicate sandbox boundaries;
under the C3-D1 YOLO decision there is no sandbox to describe, so those
fields are Derived and intentionally absent.

### C5-D4 — Instruction layers

Disposition: **Converge.**

Codex composes user-level instructions (`$CODEX_HOME/AGENTS.override.md` then
`AGENTS.md`) ahead of project documents, with subagents inheriting the
parent's text. Yakitori adds the same user layer under its own home
directory, joined ahead of the project sections. Child sessions are not
passed the parent's text at spawn: every thread resolves the same home-level
file through its own loader, so mid-session user-file edits surface in
children as well — a deliberate simplification of Codex's spawn-time freeze.
The user file has its own 32 KiB budget with a truncation marker (a local
resource-safety boundary; Codex leaves user instructions uncapped), and
project documents share the configured limit below it. The project-doc walk
itself (workspace root to working directory, `AGENTS.override.md` then
`AGENTS.md` per directory, 32 KiB shared budget, truncation marker,
symlink-escape rejection) already matches Codex.

Freshness: project instructions are still evaluated every Step so mid-session
edits flow through the world-state diff, but unchanged files are no longer
re-read — a per-thread cache keyed by path and mtime stats the candidate
files and re-reads only on change. No file watcher; watch lifecycle cost
exceeds the saving.

### C5-D5 — Trust gating for instructions

Disposition: **Derived.**

Codex skips project documents for untrusted projects. Under C3-D1, Yakitori
executes with full host authority and instruction text carries no execution
privilege, so no trust gate applies to AGENTS.md content. This conclusion is
scoped to instruction text only: if project-layer configuration later
declares hooks or MCP servers (code execution paths), the trust boundary must
be re-audited before such keys are accepted.

### C5-D6 — Extension surface: MCP, skills, plugins, connectors, hooks

Disposition: **Open; product sequencing.**

None exist in Yakitori today. The entry contracts are already built: external
tool sources register through `registerExternal` / `replaceExternalSource`
with namespaced identity, deferred exposure, readiness, and per-Step router
snapshots (`src/runtime/tools/registry.ts`); model-visible catalogs attach as
world-state sections. Codex-specific findings recorded for the future audit:
MCP connections are owned by a manager that diffs connection identity and
reuses live connections, with lazy-when-cached startup from a persisted tool
catalog; skills are `SKILL.md` files discovered from user, repo, system, and
plugin roots with a token-budgeted catalog section; connectors are
ChatGPT-backend applications riding a reserved MCP server and are unlikely to
map to Yakitori's multi-provider boundary; hooks follow the Claude Code
eleven-event vocabulary with hash-pinned trust. Deciding whether and when
each of these enters the single-Mate product remains with the user.

### C5-D7 — Configuration layering

Disposition: **Open; deferred to C8.**

Yakitori has a single global `~/.yakitori/config.toml`. Layered configuration
(project-scoped keys with trust rules) has no consumer until the C5-D6
extension work lands, so building it now would be speculative. One contained
fix lands with C5: `model_instructions_file` resolves relative to the config
file's directory rather than the server process cwd.

Evidence anchors:

- Yakitori: `src/runtime/project-instructions.ts`,
  `src/runtime/environment-context.ts`, `src/runtime/user-shell-env.ts`,
  `src/runtime/tools/unified-exec.ts`, `src/runtime/world-state.ts`,
  `src/runtime/session-configuration.ts`, `src/server/user-config.ts`.
- Codex: `core/src/agents_md.rs`, `core/src/agents_md_manager.rs`,
  `core/src/context/`, `core/src/shell.rs`, `core/src/shell_snapshot.rs`,
  `shell-command/src/shell_detect.rs`, `core/src/exec_env.rs`.
- Claude Code (secondary): `src/utils/shell/bashProvider.ts`,
  `src/utils/bash/ShellSnapshot.ts`, `src/utils/Shell.ts`.
- grok-build: `xai-grok-tools/src/computer/local/terminal.rs`,
  `shell_state.rs`, `static_shell.rs`, `xai-grok-config/src/shell.rs`.
- opencode (secondary): `packages/core/src/shell.ts`,
  `packages/core/src/shell/select.ts`,
  `packages/desktop/src/main/service/shell-env.ts`.

---

## C6 — Subagents, AgentControl, and Mate lifecycle

Status: audited. The core coding-subagent boundary is implemented. Role
catalogs, runtime residency/eviction, and model-facing close/resume remain
separate follow-up capabilities rather than hidden requirements of the core
tree.

### First-principles problem

A subagent is not merely a background Promise. It is another runnable
conversation with four identities that must agree:

1. durable Thread storage, which owns resumable model history;
2. a durable parent/child edge, which makes the tree discoverable after process
   loss;
3. a process-local control identity and canonical path, which routes tools;
4. live Session status, which owns whether work is pending, running, terminal,
   interrupted, or shut down.

The former Yakitori boundary kept the third identity in memory while child
Sessions were durable. After restart, the child could still exist while
`wait`, `followup`, `interrupt`, and completion notification had forgotten it.
Trying to fix only the status map would leave the same split authority around
spawn, message delivery, deletion, and recovery.

### C6-D1 — AgentControl ownership

Disposition: **Converge on Codex; implemented.**

Codex creates at most one `AgentControl` for a root thread tree and shares it
with every descendant. It owns the tree-scoped registry, path identity,
execution admission, rollout budget, and a weak route back to
`ThreadManagerState`. Each child is a real `CodexThread`/`Session`, so status
and execution remain Session-owned rather than copied into the registry.

Yakitori now has the same ownership shape:

```text
root Thread
  -> one AgentControl shared by the tree
       -> canonical path registry and bounded task workers
       -> AgentRuntime adapter
            -> ThreadManager creates/resumes real child Threads
            -> AgentGraphStore persists parent/child topology
```

`AgentControl` is the process-local control plane. It is not a second Session
state machine. Child status comes from the child Session or its stored rollout,
and the child uses the ordinary Turn processor and tool boundary.

grok-build makes a materially different choice. Its channel-owned
`SubagentCoordinator` is a general background-task actor with queued,
pending, active, completed, waiter, deadline, cancellation, and buffered
completion state. Host-specific `ChildRunner` adapters launch child sessions,
and nested spawns are reparented to the root coordinator. That design is a
good fit for one task system spanning shell commands, foreground/background
subagents, workflows, worktrees, and explicit output retrieval. It is not the
selected topology for Yakitori's Thread-native coding-agent tree.

### C6-D2 — Durable topology and restoration

Disposition: **Converge on Codex V2; implemented.**

Codex persists thread-spawn edges separately from rollout history. Open edges
restore agent metadata without eagerly reopening every runtime; a later
operation can load the selected Thread. Explicitly closed edges are excluded
from open-tree restoration. The in-memory registry remains disposable.

Yakitori now persists the same purpose-specific topology in
`AgentGraphStore`. Child creation stays provisional until both Thread storage
and the graph edge exist, so an uncommitted child is never routable. Resume
loads open descendant identities lazily. If process loss occurs after Thread
creation but before edge commit, stored subagent metadata backfills the missing
edge; a recovered `pending_init` child is durably failed because its initial
task was never admitted. Deletion is deepest-first and storage-first; an edge
whose Thread is already absent is treated as a cleanup tombstone and
reconciled on retry or resume. The graph contract therefore requires
ancestor-before-descendant enumeration and makes partial deletion recoverable.

This graph is not a scheduler or a projection of live status. grok-build's
coordinator instead owns process-local child records and may persist output or
resume snapshots for its task workflow; it does not establish the selected
per-root Thread graph boundary.

### C6-D3 — Inter-agent delivery and completion

Disposition: **Converge on Session-owned model-visible delivery; implemented
with a stronger Yakitori durability receipt.**

Codex routes `InterAgentCommunication` through the target Session and
distinguishes communication that triggers a Turn from input delivered at a
sampling boundary. Agent status is a Session watch value, and completion
watchers format notifications back to ancestors.

Yakitori likewise delivers through the target Session rather than keeping an
AgentControl mailbox. One atomic `agent_message` rollout item contains both a
stable receipt id and the model-visible message. The Session accepts that item
into its single-writer retry buffer, serializes it with context mutation, and
flushes before acknowledging delivery. The same receipt survives compaction,
flush retry, completion retry, and restart, so redelivery is idempotent without
allowing a receipt to outlive its payload. Completion ids derive from the
durable lifecycle marker that determines the reconstructed terminal outcome,
including an unmatched `turn_started` after process loss; restoration can
therefore reissue a missed notification without rerunning the child.

This is a named Yakitori reliability requirement, not a claim that every
Codex rollout append has a universal fsync barrier. It exists because the
sender consumes a completed child task only after the parent has durably
accepted its notification.

grok-build instead supports foreground return values and buffered background
completions retrieved through its task-output tools. That completion
disposition belongs to its unified task coordinator and is not mixed into the
selected Session mailbox contract.

### C6-D4 — Context, depth, and execution bounds

Disposition: **Converge on the Codex direction; core subset implemented.**

Both systems give a child its own context window and bounded execution.
Yakitori supports fresh context or an explicit all/last-N parent snapshot,
inherits the current model target unless overridden, enforces canonical path
uniqueness before asynchronous creation, and reserves concurrency before the
first admission await. Children can delegate only within the configured tree
depth.

Codex additionally owns role definitions, nickname allocation, rollout
budgets, environment inheritance, and V2 LRU runtime residency. grok-build
adds agent definitions, personas, capability modes, foreground/background
budgets, resume-from snapshots, and optional worktree isolation. Those are
real product surfaces, not prerequisites for the core tree. Agent/role/tool
catalog work belongs to C5, rollout-budget policy to C2-D6, and runtime
residency plus explicit close/resume behavior to C7.

### C6-D6 — Mate boundary

Disposition: **Deliberate.**

The current product has one configured Mate identity and immutable revision
attribution. Child Threads inherit that attribution because they execute as
delegates of the same coding agent. They are not persistent colleague Mates,
do not own long-term memory, and do not create Rooms. The later Room/Mate
direction must not be inferred from the subagent graph.

Evidence anchors:

- Yakitori: `src/runtime/agent-control.ts`, `agent-runtime.ts`,
  `tools/multi-agent.ts`, `src/core/session.ts`, and
  `src/core/agent-graph-store.ts`.
- Codex: `core/src/agent/control.rs`, `control/spawn.rs`,
  `control/residency.rs`, `agent/registry.rs`, and multi-agent tool handlers.
- grok-build: `xai-grok-tools` task coordinator/admission modules,
  `xai-grok-shell` subagent runner, and the subagent user guide.

---

## C7 — Process lifecycle and operational failure observation

Status: the application-lifecycle slice is audited and implemented. Broader
runtime concurrency, lock recovery, residency, and diagnostics remain future
C7/C9 audit work.

### C7-D1 — Shutdown ownership

Disposition: **Converge on Codex; implemented.**

Codex separates shutdown request from teardown. On the first signal its
app-server enters a draining state, continues serving requests while assistant
Turns are active, and starts transport/task/resource teardown only after the
running count reaches zero. A second signal is an explicit forced exit.

Yakitori now has the same process contract. `ThreadManager` is the authority
for live active-Turn ownership. The shared server-process owner observes that
count for both standalone and packaged entry points. At the zero-Turn
transition it closes a process-wide request gate and the HTTP listener
synchronously. Like Codex's `ConnectionRpcGate`, work admitted before close is
tracked and drained while later work is never polled. Yakitori then rechecks
and drains any Turn that an admitted request started before it closes
`ThreadManager`, Session workers, stores, and locks. The Electron parent
directly owns the real sidecar in development and production, sends the first
termination request, and waits without an independent deadline; a second quit
uses the explicit force path. This also removes the previous development
versus packaged drift in privileged attachment-control IPC.

### C7-D2 — Failures without a caller

Disposition: **Converge on Codex's ownership semantics; implemented through a
thin Yakitori reporting contract.**

Codex does not turn operational failures into one global error hierarchy.
Detached task owners and lifecycle loops observe failures locally through
tracing, preserve the owning module's error semantics, and decide whether to
retry, terminate, or continue.

Yakitori follows that split. Expected provider, persistence, tool, HTTP, and
domain failures retain their existing contracts. A narrow reporter is used
only when a failure can no longer be returned to a caller—for example event
subscriber rejection, background Turn/subagent work, cleanup, a tolerated
configuration fallback, or top-level unexpected request failure. Reports keep
the original cause plus owning component/operation and available Session,
Turn, or event-range context. Reporting is isolated from the operation itself,
so a synchronous reporter throw or asynchronous reporter rejection cannot roll
back durable work or break teardown. Turn-processor reports name the owner-local
operation (`abort-model-stream`, `close-model-stream`, `compact`, or
`execute-tool`) rather than collapsing unrelated failures into a generic
background-task label. Expected provider context-overflow retry remains on its
normal compaction path and is not reported as an operational failure.

Evidence anchors:

- Yakitori: `src/server/server-process.ts`, `shutdown.ts`,
  `operational-errors.ts`, `src/core/thread-manager.ts`, and
  `src/runtime/agent-control.ts`.
- Codex: `app-server/src/lib.rs`, `app-server/src/connection_cleanup.rs`,
  `app-server/src/thread_processor.rs`, and `rollout/src/recorder.rs`.

## Progress log

### 2026-09-03

- Completed the C5 audit for instructions, environment, and shell; MCP,
  skills, plugins, connectors, hooks, and config layering remain Open product
  decisions (C5-D6/C5-D7).
- Removed the model-facing `shell` parameter from `exec_command`; shell
  identity is host-owned (C5-D1).
- Added the detected shell name to the environment world-state section
  (C5-D3).
- Added a cross-session login-shell snapshot sourced per exec command so
  aliases and functions reach model commands, with three-day retention and a
  non-login validation pass (C5-D2).
- Added user-level `$YAKITORI_HOME/AGENTS.override.md`/`AGENTS.md`
  instructions ahead of project documents, and an mtime-keyed per-thread
  project-instructions cache (C5-D4).
- Resolved `model_instructions_file` relative to the config file directory
  instead of the server process cwd (C5-D7).
- Audited and implemented the C4 provider core against Codex and grok-build.
- Selected Codex provider/Session/Turn ownership while retaining one
  grok-build-style tagged multi-wire conversation algebra for first-class
  Anthropic Messages and OpenAI Responses transports.
- Added provider-scoped model managers, target-independent Turn transport
  sessions and request-scoped Step configuration,
  output-aware retry with `Retry-After` and idle deadlines, Codex credential
  single-flight and pre-output 401 recovery, provider-and-account continuation
  fencing, durable
  provider request IDs, and separate billing versus active-context usage.
- Kept remote model discovery provider-specific and left model-switch
  compaction, host rate-limit presentation, and diagnostics in their existing
  C2/C8/C9 boundaries.

### 2026-09-02

- Audited and implemented the C7 application-lifecycle slice against Codex.
- Unified standalone and packaged startup, attachment-control IPC, first-signal
  active-Turn drain, second-signal forced exit, and Electron parent ownership.
- Added Codex-style request admission and in-flight draining across HTTP and
  privileged control IPC, including a second active-Turn check after admitted
  requests finish; development Electron now directly owns the real sidecar.
- Added one context-bearing operational failure outlet for detached work while
  preserving each module's expected-error contract, isolating asynchronous
  reporter rejection, and retaining owner-local Turn operation names.

### 2026-08-31

- Completed the C6 audit and selected Codex's per-root AgentControl over
  grok-build's global task/subagent coordinator.
- Added real child Threads, durable spawn topology, provisional spawn commit,
  lazy identity restoration, Session-owned status, retry-safe inter-agent
  delivery, restart-safe completion notification, and recoverable subtree
  deletion.
- Kept persistent colleague Mates and Rooms outside the coding-subagent tree.

### 2026-08-29

- Established comparison baselines and excluded GUI/renderer scope.
- Inventoried nine non-GUI major modules.
- Completed C1 audit of execution authority, persisted protocol, commit
  semantics, schema compatibility, fork, recovery, projection, and mutation
  serialization.
- Completed C2 audit of Turn/Step snapshots, prompt ownership, capacity
  admission, steering, compaction, bounded work, model switching, and world
  state.
- Selected Codex's current `ThreadManager` / `CodexThread` / `SessionIo` /
  `Session` / `ThreadStore` ownership topology for C1 instead of defining a
  Yakitori-specific actor architecture.
- Selected Codex rollout persistence, recovery, and fork semantics for the
  same boundary, including one Codex-style rollout item direction for all
  provider adapters.
- Completed the live-runtime cutover under `src/core`: `ThreadManager`,
  `CodexThread`, bounded `SessionIo`, Session-owned `ContextManager`, explicit
  `PersistContext`, on-demand resume, `start` / `steer`, and flush/shutdown
  barriers now own the production path.
