# Architecture Convergence Register

This register contains only unfinished architecture work. Code, public types,
and focused tests are authoritative for behavior that has already landed.

Yakitori has no production users or compatibility obligation yet. Prefer a
clean schema break or deletion over compatibility code unless a real
requirement establishes otherwise.

Primary references are `.references/public/codex` and
`.references/public/grok-build`. If they make materially different choices,
record the alternatives and ask for a product decision instead of silently
synthesizing a third architecture.

## Delivery order

Stages are ordered by severity: user-visible correctness defects first, then
recovery correctness, then failure observability, then contained contract
fixes, then hygiene. Same-module problems are grouped into one stage so the
owning boundary moves once.

| Order | Outcome | Owning areas | Severity driver |
| --- | --- | --- | --- |
| 1 | Agent lifecycle reads from durable session state | runtime agent-control, mates | Restart orphans running subagents |
| 2 | Application and background failures observable | server application/start/desktop-entry | Silent failures, but no known incident |
| 3 | Production exports narrowed, test support separated | runtime and server public surfaces | Hygiene; churns exports, so it runs last |

The next piece of work is Stage 2. Stages 2–4 should follow in order; later
stages do not block earlier ones.

## Stage 2 — Agent lifecycle durable authority

Absorbs the former Stage 2B.

### Current behavior

`AgentControl` tracks agents, statuses, and the path tree in process memory
(agent-control.ts:135), but every child agent is a real kernel session whose
state is durable: the runner's `readAgentOutcome` re-derives outcomes from
the child projection (session-runner.ts:1792), and recovery reconciles
kernel sessions without consulting AgentControl (recovery.ts:16). On process
restart with a running child, recovery may interrupt and re-wake the child
session while the parent's AgentControl map is empty — `wait`/`interrupt`/
`followup` cannot see or stop the still-running child, and its completion
enqueues no `subagent_notification`.

An Agent is also assigned `pending_init` and synchronously moved to
`running` by the same start path, so the intermediate state is
unobservable. Mate revision and lifecycle mutation APIs have test callers
but no production writer; they preserve a future persistent-colleague design
outside the current single-Mate product goal.

### Target boundary

- Agent status is derived from child session projections; AgentControl holds
  at most ephemeral handles for the running process, and restart
  reattachment or explicit orphan reconciliation is part of recovery.
- Remove `pending_init` unless initialization becomes an asynchronous,
  externally observable phase with a real failure/retry contract.
- Remove unused Mate revision and lifecycle mutation surfaces, their
  exports, and tests that only exercise those unreachable paths.
- Keep the current bounded subagent execution lifecycle; do not pull future
  Room or persistent-memory design into this contraction.

### Done when

- A restarted parent cannot lose track of a child session that is still
  executing.
- Every lifecycle state corresponds to a production-observable interval and
  a valid transition owner.
- Public mutation APIs have a real product caller rather than only fixtures.

## Stage 3 — Application lifecycle and background failures

Sequenced after Stage 1 because its error-reporting hooks land on the event
hubs. One Session delivery hub orders durable item/Turn batches with transient
usage, permission, and streamed-display events. Persistence and domain types
remain separate: all item starts, streamed deltas, and progress are live-only;
complete item snapshots are durable.

### Current behavior

`start.ts` and `desktop-entry.ts` separately assemble the application,
listen, handle signals, and shut resources down. Their process semantics can
drift. The production HTTP constructor also accepts handlers, a kernel, or
an event store; the latter two exist for test convenience and widen the
production contract.

The Session delivery hub accepts an optional listener-error hook, but production
does not install one. A failed asynchronous listener can therefore be invisible
even though the durable write succeeded. Runner and recovery code also repeat
structural checks for selected kernel
`InvalidState` failures; the concrete instance is the fork interrupt/retry
loop matching `error.details?.operation` structurally
(`forkAfterSettlingActiveTurn`, handlers.ts:117-144).

### Target boundary

- One application owner assembles dependencies, listens, handles signals,
  drains, and closes resources. CLI and desktop entry points derive options
  and call it.
- The production HTTP constructor accepts one handler/service boundary.
  Tests get kernel/store convenience from test support.
- Extend the existing kernel error guard with optional code matching instead
  of repeating structural predicates.
- Require an operational error reporter wherever background work or listener
  delivery can fail. Subscriber failure must not roll back durable writes,
  but it must identify the component, Session, event range, and cause.

This does not require one global error hierarchy. Kernel, provider, tool,
HTTP, and storage modules retain their own contracts; each owning boundary
translates expected failures and reports unexpected ones.

### Done when

- CLI and desktop cannot drift in startup or shutdown semantics.
- Production APIs do not accept dependencies solely for tests.
- No fire-and-forget Promise or event listener can fail silently.
- Expected errors preserve their stable code and unexpected errors preserve
  their cause through the reporting boundary.

Reference anchor:

- `.references/public/codex/codex-rs/app-server/src/lib.rs`

## Stage 4 — Production surface cleanup

Run this only after the preceding owners stabilize, so cleanup does not
churn exports that are about to move again.

### Current behavior

Some runtime and server barrels expose test-oriented constructors and
fixtures. `runtime/faux-provider.ts` is a test harness exported from the
runtime surface. It is distinct from the application's production faux
scenario stream, which currently supports the development default and must
not be removed by name association alone.

Several modules contain similar `isRecord`-style validation helpers. Most
sit at different trust boundaries and do not justify a universal shared
guard.

### Work

- Move test-only providers, constructors, and fixtures to explicit
  test-support entry points.
- Remove unused barrel exports after checking production, dynamic-import,
  persisted, and test consumers.
- Keep validation local when schemas or trust boundaries differ; share a
  guard only when more than one real caller enforces the same durable
  contract.
- Delete dead code and vacuous tests discovered by the export audit.

### Done when

- Production entry points expose only supported runtime contracts.
- Test support is importable without widening production APIs.
- No development feature is deleted merely because it resembles a test
  fixture.

## Resolved work that must stay resolved

The following are constraints, not future modules:

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
  sequence numbers. SSE replay-complete marks only the snapshot's durable
  watermark; post-snapshot deliveries drain afterward in arrival order. During
  that drain, display events are reconciled against the snapshot and later
  durable Turn facts, so a terminal snapshot cannot be followed by its stale
  buffered delta.
  Active activity is derived from all open entries rather than transferred by
  the latest event, so parallel tools and permissions remain accurate.
- Effective session model, session usage totals (including compaction), and
  terminal item disposition are derived by the kernel projection. The DTO
  exposes them; the runner reads the same model selection the DTO shows.
  Tool recovery uses durable model call/result items and terminal completion
  snapshots, never a persisted display-start event.
- Still-pending permission requests replay as `permission.requested` after
  `session.replay-complete` on every SSE (re)connect; resolving stays a POST
  whose confirmation arrives through the stream.
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
