# Architecture Convergence Register

This register records the accepted Codex-convergence batch and its completion.
Code, public types, and focused tests are authoritative for landed behavior.

Yakitori has no production users or compatibility obligation yet. Prefer a
clean schema break or deletion over compatibility code unless a real
requirement establishes otherwise.

Primary references are `.references/public/codex` and
`.references/public/grok-build`. If they make materially different choices,
record the alternatives and ask for a product decision instead of silently
synthesizing a third architecture.

## Accepted scope — completed 2026-09-07

The user selected Codex for context admission, compaction, rollout budgets,
model switching, local configuration, MCP, skills, hooks, runtime residency,
locking, diagnostics, and history search. Yakitori keeps its tagged
multi-provider history IR where Codex's Responses-only representation cannot
carry Grok and Kimi history. Plugin distribution, connectors, enterprise
administrator constraints, persistent colleague Mates, and Rooms remain
outside this batch.

The implementation is split into reviewable ownership layers:

- context uses provider/model-attributed usage baselines, estimates complete
  history when a matching baseline is unavailable, and treats local capacity
  as an early warning before provider overflow enters the compaction path;
- Codex native and local compaction replace history inside the existing IR,
  preserve user input and environment baselines, and retain the original
  failure when a model fallback also fails;
- one root AgentControl owns the optional shared rollout budget and bounded
  child execution, while model switches compact only when provider metadata
  establishes a compatibility or capacity boundary;
- local user/project configuration records provenance and fingerprints,
  checks project trust before parsing executable settings, and protects user
  writes with optimistic version checks under an OS advisory transaction lock;
- each Session resolves its own configuration and owns its Hook runner, MCP
  processes, and live external-tool catalog; failed MCP processes reconnect
  and republish tools;
- Codex, Grok, and Kimi expose only executable model choices, use authenticated
  discovery with bundled metadata fallback, and report provider limits as
  unavailable unless an authoritative source supplies them;
- completed child runtimes are evicted per root, close/resume is serialized,
  and one OS advisory lock owns a store across processes;
- diagnostics expose content-free process gauges, while durable search uses
  visible text and stable cursor semantics in the ThreadStore;
- test-only providers live under `test/support`, and unused production barrels
  have been removed.

The complete batch is covered by `pnpm check`; renderer availability was also
verified in a browser and the Electron sidecar bundle was built.

## Resolved work that must stay resolved

The following are constraints, not future modules:

- Standalone and Electron-sidecar startup, privileged control IPC, signal
  handling, and resource teardown share one process-lifecycle owner. The first
  shutdown request keeps transports open while any Session owns an active Turn;
  when the count reaches zero, one process-wide request gate synchronously
  closes HTTP and control-IPC admission and the listener stops accepting new
  connections. Requests admitted before that boundary drain before their
  resulting Turns are checked again; only then do Thread admission and owned
  resources close. A second request forces exit. The Electron parent directly
  owns the real sidecar process and imposes no hidden first-request kill
  deadline.
- Modules retain their own expected-error contracts. Failures from detached
  workers, listeners, fallback paths, or cleanup that can no longer reach a
  caller cross one narrow operational-reporting boundary with component,
  operation, cause, and available Session/Turn/event-range context. Reporter
  failure, including an asynchronous reporter rejection, cannot alter domain
  work, persistence, delivery, or cleanup.
- Assistant and reasoning display items start live, then receive transient
  suffix deltas keyed by item id; providers emit cumulative snapshots
  internally and the runtime converts them to bounded publications. A final,
  non-empty `item.completed` is a self-contained durable host-history fact;
  `response_item` remains authoritative for model history. Tool and compaction
  starts and progress are likewise live-only; their final `item.completed`
  snapshots are durable. There is no durable `item.started`, no fabricated
  empty completion, and no separate UI update log. This follows Codex's current
  paginated rollout behavior rather than its legacy compatibility paths or
  grok-build's `updates.jsonl` design. On a live interrupted Turn, the GUI
  retains a client-only non-empty prefix beside the terminal marker; reconnecting or
  restarting cannot recover that prefix. An intentional Interrupt records a
  hidden user-role `<turn_aborted>` context marker and the interrupted terminal
  in one durable append batch; the partial display text is not model-visible.
  Runtime-loss recovery uses the distinct interruption notice. The runtime
  flushes pending transient publications before terminal Turn disposition.
  Durable and transient publications share one per-Session delivery owner, so
  subscribers observe their original publish order without assigning transient
  sequence numbers. The `session/replayComplete` notification marks only the
  snapshot's durable watermark; post-snapshot deliveries drain afterward in
  arrival order. During that drain, display events are reconciled against the
  snapshot and later durable Turn facts, so a terminal snapshot cannot be
  followed by its stale buffered delta.
  Active activity is derived from all open entries rather than transferred by
  the latest event, so parallel tools and permissions remain accurate.
- Effective session model, session usage totals (including compaction), and
  terminal item disposition are derived by the kernel projection. The DTO
  exposes them; the runner reads the same model selection the DTO shows.
  Tool recovery uses durable model call/result items and terminal completion
  snapshots, never a persisted display-start event.
- Still-pending permission requests replay as `permission.requested` after
  the `session/replayComplete` notification on every (re)subscribe, and the
  same replay re-sends their answer channel: resolving a permission is the
  response to the `session/permission/request` server→client request, and the
  confirmation still arrives through the event stream.
- Durable Turn terminals, completed-item snapshots, approval resolutions, and
  recovery facts are closed. Permission waiting is transient active-Turn
  state; recovery cannot grant or deny a permission after the Turn.
- Session execution policy, per-call tool requests, and process safety caps
  have separate owners. Process caps are not persisted as Session preferences.
- Development-only persistence compatibility has been removed. Do not add
  migrations or fallback storage paths without a real compatibility obligation.
- Session recovery is an effectful reconciliation: close interrupted Turns,
  append required expiration resolutions, publish resulting events, then wake
  pending input.
- Event stores, Session kernels, and file writes retain owner-local sequencing.
  Do not introduce a shared `KeyedSequencer`; the superficially similar queues
  have different atomicity and lifecycle contracts.
- EventStore clones and the validated Session-summary cache remain ownership
  and trust boundaries.
- Projection-to-domain mapping may have one owner. Cache decoding and API
  mapping stay explicit because disk validation and wire exposure are different
  contracts.
- Small formatting helpers and similar local predicates are not architecture
  work unless duplication causes a concrete ownership or behavior drift.

When a stage lands, delete its planning section from this register. Do not keep
a second prose description of behavior already made authoritative by code and
focused tests.
