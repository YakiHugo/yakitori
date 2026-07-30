# Session Storage Strategy Research

> Archived 2026-07-30: consolidated into `docs/kernel-persistence-direction.md`.
> This document is a historical record — do not implement from it. Decision
> 0009 and `docs/kernel-persistence-direction.md` are authoritative for the
> per-fact journal; its completed stage plan is archived at
> `docs/archive/stage-2-fact-journal.md`.

This document preserves the current Session-storage investigation so later
discussion can compare the reference products and choose a kernel persistence
strategy without treating an intermediate proposal as settled architecture.

Decision 0009 supersedes decision 0008's record format, batch recovery
boundary, and operation receipts. Do not implement directly from this
document.

## Current Shared Conclusions

- One execution Session has one logical writer. A per-Session JSONL history is
  therefore a better canonical transcript candidate than using SQLite to solve
  unsupported concurrent writes to the same Session.
- SQLite remains appropriate for relational data such as Mates, Rooms, Tasks,
  Messages, and Deliveries. It may also hold rebuildable Session indexes and
  projections, but it must not become a second authoritative execution
  history.
- The current format, one line per `{ events: [...] }` commit batch, may be too
  coarse for future history manipulation.
- Codex, Kimi Code, and observable Claude Code behavior suggest investigating
  smaller persisted units such as items, operations, or messages rather than
  treating a whole kernel command batch as the durable record.
- Small logical records do not require one `fsync` per record. Several complete
  fact lines may be serialized into one buffer and admitted through one
  `writeAll` plus one file synchronization.
- Recovery may retain every complete fact line that reached the file. Only the
  final unterminated fragment is a torn tail. A Turn or Tool with an opening
  fact but no terminal fact is honest incomplete history, not evidence that it
  failed.
- Large Tool output must live in an artifact or blob store. The Session JSONL
  records only a bounded preview, integrity metadata, and a reference.
- `summary.json` remains a disposable, rebuildable listing cache.
- A fork needs an exact source boundary, for example
  `forkedFrom: { sessionId, throughSeq }`, rather than only a parent Session ID.

## Why Smaller Durable Records Are Attractive

One-fact-per-line storage gives later consumers a stable unit for:

- forking through an exact sequence;
- selectively filtering private, obsolete, or unsupported facts;
- rewriting Session-local IDs while materializing a child Session;
- migrating one fact schema at a time;
- recovering bounded model context from a compaction checkpoint and suffix;
- incrementally indexing by logical sequence and physical byte offset;
- precise rewind and history pagination; and
- representing an incomplete Turn or Tool without synthesizing closure facts.

The intended separation is:

```text
logical durability unit    one complete fact line
physical I/O unit          one buffer containing one or more fact lines
durability barrier         one successful file sync for that buffer
recovery unit              the complete-line prefix present after restart
```

This deliberately gives up the current `appendEvents` zero-or-all-events
recovery contract. Adding batch IDs, item counts, or a final batch commit marker
would restore batch transactions and defeat the main reason to adopt smaller
lines.

## Reference Product Notes

### Codex

Codex rollout storage is the closest structural reference currently available
locally:

- `RolloutLine` contains a timestamp, an optional ordinal, and one flattened
  `RolloutItem` represented by `type` plus `payload`.
- A writer command may enqueue several items, but they remain independent JSONL
  lines. On an I/O failure, the writer retains the unwritten suffix rather than
  rolling back an already written prefix.
- The inspected implementation uses file writes and flushes, not Yakitori's
  required file-sync durability. It is a record-layout and ownership reference,
  not proof of an `fsync` protocol.

Relevant local sources:

- `.references/public/codex/codex-rs/protocol/src/protocol.rs`
  (`RolloutItem` and `RolloutLine`)
- `.references/public/codex/codex-rs/rollout/src/recorder.rs`
  (`pending_items`, ordinal advancement, and JSONL writes)

### Kimi Code

The current official mainline is the TypeScript `MoonshotAI/kimi-code`
repository. The former Python `MoonshotAI/kimi-cli` repository is being wound
down, so its separate `context.jsonl` and `wire.jsonl` streams are useful only
as a legacy comparison. The observations below are pinned to Kimi Code commit
`f8ec3d1656326eecc2bc2fb6a1163d351bb596cc`.

Kimi Code stores one authoritative execution stream per Agent rather than one
shared multi-agent file:

```text
sessions/<workspaceId>/<sessionId>/
  state.json
  agents/<agentId>/wire.jsonl
  agents/<agentId>/blobs/...
```

This is compatible with Yakitori's execution-lane boundary: independent Mates
may run concurrently, while each Mate Session still has one append owner. The
Session-level `state.json` and compatibility indexes are atomic documents or
derived data; the per-Agent `wire.jsonl` is the cold-rebuild source for the
execution transcript. Kimi's owner is process-local rather than a cross-process
file lease, and its SDK documentation does not support concurrent writers to
one Session. Yakitori should still keep a defensive ownership lock so two
accidentally launched servers cannot violate the topology rule.

The physical JSONL format begins with one protocol metadata line and then
stores one typed operation per line. Object payload fields are flattened into
the record:

```json
{"type":"metadata","protocol_version":"1.5","created_at":1720000000000}
{"type":"turn.prompt","time":1720000000001,"prompt":"inspect this"}
{"type":"context.append_loop_event","time":1720000000002,"event":{"type":"tool.call","toolCallId":"call_1","name":"read_file","arguments":{}}}
{"type":"context.append_loop_event","time":1720000000003,"event":{"type":"tool.result","toolCallId":"call_1","output":"..."}}
```

The append implementation is the clearest reference found so far for the
proposed separation between logical and physical durability granularity:

- each submitted operation is serialized as an independent JSON value plus a
  newline;
- all operations pending in the same drain are concatenated into one byte
  buffer;
- that buffer is passed to one file append and one `FileHandle.sync()`; and
- tests explicitly verify that ten logical appends may become one durable file
  append.

Consequently, a crash during one physical batch may leave any complete prefix
of its logical lines. Kimi does not restore multi-operation transaction
atomicity with a batch commit marker. This is the same recovery model being
considered for Yakitori: every complete line is independently meaningful even
when several lines share one sync.

Kimi's append error policy is deliberately sticky. Any append failure is
treated as ambiguous because bytes may have reached the file even when the
caller received an error. It does not automatically retry the batch and risk
duplicates. An explicit atomic rewrite is required to recover the store. This
is safer than blind retry, although Grok's distinction among not committed,
committed, and acknowledgement lost is a better basis for Yakitori's operation
receipt protocol.

Recovery distinguishes a normal torn tail from committed corruption:

- a final non-newline fragment that cannot be decoded is ignored;
- a malformed newline-terminated interior record raises a corruption error;
  and
- records are streamed through typed reducers rather than first being turned
  into one GUI transcript.

There is nevertheless an important repair omission. The reader drops an
invalid torn final fragment, but the next writer opens the file in append mode
without first truncating it. A valid final JSON value that lacks its newline is
accepted by the reader but is likewise not repaired. In either case, a later
valid line can join onto the old tail and become a malformed committed line.
Yakitori must truncate an invalid tail, or append the missing newline to a
complete final value, and sync the repair before reopening normal appends.

The operation registry is a strong schema boundary. Each domain defines a
typed operation, a validation schema, a pure reducer, whether the operation is
persisted, and any projected runtime event. Restore applies protocol migrations
record by record and may atomically rewrite the log to the newest protocol.
This is better than letting persisted records equal provider messages or UI
Items, but Yakitori should tighten several details:

- Kimi has a file-level protocol version but no per-fact schema version;
- it has no stable fact ID or gap-detecting Session sequence;
- migration currently collects the rewritten log in memory, so it is not a
  bounded streaming rewrite;
- unknown or schema-invalid operation records may be reported and skipped,
  whereas Yakitori should preserve unknown records opaquely and reject a
  malformed known record; and
- a rewrite changes every byte offset, with no logical sequence available as a
  stable coordinate.

Kimi's Tool history is physically small and well separated: a model-proposed
`tool.call` and its later `tool.result` are distinct loop-event records. Its
reducer may therefore observe a genuinely pending Tool at the end of a complete
prefix. Provider-context projection can synthesize an explicitly interrupted
compatibility result when an API requires call/result pairing without writing
that result back as a canonical observation. That separation is worth copying.

Its status model is not sufficient for Yakitori, however. Persisted Tool
results mainly carry `isError`; cancellation and interruption can collapse into
error strings, while permission decline and an unknown post-crash outcome are
not first-class durable outcomes. `failed` cannot honestly represent all of
those states. Kimi also persists prompt/cancel operations and loop step events,
but `turn.started` and `turn.ended` are runtime events rather than authoritative
facts, so some Turn boundaries are derived instead of directly witnessed.

Large inline media values are dehydrated into content-addressed blobs before
the referring wire operation is appended. The log retains a `blobref` containing
the MIME type and SHA-256 digest. The artifact-before-fact ordering is the
correct cross-file saga direction: an orphan blob can be garbage-collected,
whereas a durable fact should not reference an unpublished blob. Kimi applies
this only to media data URLs; Yakitori should generalize it to bounded previews
and references for large textual Tool output.

Compaction is append-oriented in the current mainline. Separate operations
record begin, cancel, application of the compacted context, and completion.
Applying compaction replaces the model-visible context reducer state with a
bounded summary while leaving the raw wire history intact. A crash after begin
or after applying the summary therefore leaves a meaningful prefix that replay
can represent. This is substantially stronger than the old Kimi CLI's context
file rotation and is close to the desired Yakitori context-checkpoint model.

Fork flushes every live source Agent, reads its complete durable wire prefix,
adds a fork record, and atomically writes the child log. It explicitly accepts
that an active source may be copied at a logically incomplete Turn boundary.
This is honest and useful. The current fork still copies the whole stream and
records only the parent Session ID, not an exact `throughSeq`; historical
Turn-boundary fork is not implemented in the v2 SDK. Yakitori should retain
Kimi's flush-before-copy and atomic child publication while adding exact source
coordinates, selective fact rewriting, and ID provenance.

Kimi's transcript package exposes Turn-granular before/after pagination, but a
cold page currently rebuilds the transcript from the complete wire log and
then paginates in memory. A separate rebuildable search index does demonstrate
incremental projection from a remembered byte offset, consuming only complete
newline-terminated records and resetting on file shrink or rewrite. Yakitori
should combine those two ideas: stable public cursors based on logical sequence
or Turn identity, and SQLite projection checkpoints containing both sequence
and physical offset.

The largest durability gap is above the append store. `WireService.dispatch()`
first reduces the operation into memory, queues persistence, and publishes the
runtime event; the actual append and sync happen later through a microtask
drain. A Tool may start executing after its call was queued but without an
awaited durability barrier. Kimi therefore validates the grouped multi-line
write mechanism, but not Yakitori's stricter admission rule. Yakitori must await
the relevant facts' synchronized append before publishing durable observations
or crossing permission and external side-effect boundaries.

The filesystem layer also remembers that a directory has been synchronized and
does not synchronize it again in the same process. That is not a sufficient
rule for a later first creation of another journal or a later atomic rename.
Yakitori should synchronize the parent after each newly published directory
entry or replacement, not merely once per directory lifetime.

Relevant upstream sources:

- `MoonshotAI/kimi-code/packages/agent-core-v2/src/persistence/backends/node-fs/appendLogStore.ts`
- `MoonshotAI/kimi-code/packages/agent-core-v2/src/persistence/backends/node-fs/fileStorageService.ts`
- `MoonshotAI/kimi-code/packages/agent-core-v2/src/wire/wireService.ts`
- `MoonshotAI/kimi-code/packages/agent-core-v2/src/agent/contextMemory/loopEventFold.ts`
- `MoonshotAI/kimi-code/packages/agent-core-v2/src/app/sessionLifecycle/sessionLifecycleService.ts`
- `MoonshotAI/kimi-code/packages/transcript/src/pagination/paginate.ts`

### Claude Code

Claude Code remains a product-behavior cross-check for message, tool, rewind,
fork, and compaction behavior. Its exact current on-disk envelope, ordering,
tail-repair, and synchronization rules still need a source-backed comparison
before they influence Yakitori's persisted schema.

### Grok Build

Grok Build is not a pure one-log Session design. It is a transitional hybrid:

- `updates.jsonl` is explicitly described as the durable source from which the
  derived `chat_history.jsonl` can be rebuilt;
- `chat_history.jsonl` is still written and loaded directly in normal paths;
- `summary.json`, plan, goal, signals, workflow, rewind, and other files carry
  additional Session state; and
- SQLite is used for rebuildable search and listing concerns rather than as the
  canonical chat replay stream.

The update envelope is approximately:

```json
{
  "timestamp": 1720000000,
  "method": "session/update",
  "params": { "...": "notification payload" }
}
```

This gives each line a self-describing protocol namespace, but it has no
storage-envelope version, stable fact ID, Session ID, or gap-detecting Session
sequence. Seconds-resolution time and nested protocol event IDs cannot replace
a storage-level ordinal. Its legacy decoder also treats an unknown method as an
ACP notification, which is too permissive for a canonical fact store.

Grok's JSONL writer contains stronger durability machinery than its ordinary
update path uses:

- a persistence actor serializes in-process writes and drains older buffered
  updates before a requested durable append;
- a sidecar file lock protects the tail check, append, and durability barrier
  against an accidental second process or persistence actor;
- it uses `write_all`, then `flush`, and in durable mode synchronizes the file
  and parent directory; on macOS it additionally uses `F_FULLFSYNC`; and
- durable append errors distinguish `NotCommitted`, `Committed`, and
  `AcknowledgementLost`, so callers do not blindly retry an operation whose
  replay line may already have landed.

That last distinction is especially useful for Yakitori's durable input and
side-effect admission boundary. However, ordinary Session updates, including
normal Turn completion notifications, use the buffered path. The explicit
durable path is used only by selected operations such as an acknowledged
scheduled-task deletion tombstone. Grok therefore demonstrates a good
commit-aware primitive, not a guarantee that every replay fact crosses an
`fsync` barrier before publication.

Its recovery policy prioritizes availability over strict witnessing. If the
file does not end in a newline, the next append first writes a newline, turning
the old torn bytes into an isolated malformed record. Readers then skip invalid
UTF-8 and malformed JSON lines anywhere in the file; chat history additionally
keeps a first `.corrupt` evidence copy. This is suitable for opening as much UI
history as possible, but it is too permissive for Yakitori's canonical log. A
newline-terminated malformed line is committed corruption, not an ignorable
hole.

Grok exposes useful read-side primitives without yet forming a complete
history-pagination design:

- an updates iterator can seek from a byte offset and report the next offset;
- Session startup performs a full read, remembers the physical end, flushes the
  persistence actor, and reads the delta that arrived during loading; and
- search uses a rebuildable SQLite FTS index and stores a physical indexing
  offset, although the inspected delta-indexing path is not fully wired in.

This snapshot-plus-barrier-plus-delta sequence is worth adopting for live
catch-up. The raw byte offset is not a durable public cursor: Grok has no
top-level sequence, gap detection, or stable paginated Turn/Item API, and a
rewrite or migration can change every offset.

Turn and Tool recovery shows why canonical facts must be separated from model
input normalization. Grok largely derives Turn boundaries from user/agent
chunks and `promptIndex`; Tool calls progress through ACP statuses such as
`pending`, `in_progress`, `completed`, and `failed`. A completed chat item is
only emitted after terminal Tool updates. If a crash leaves an assistant item
with several Tool calls and only a prefix of Tool results, Grok repairs the
conversation by inserting synthetic Tool results such as cancelled or not
executed, and persists a replacement chat history. This satisfies provider
message-shape requirements, but it changes absence into an asserted outcome.
Yakitori should keep the incomplete durable history and, when a provider
requires paired Tool results, add explicitly synthetic compatibility items only
in the bounded model-input view.

Grok's append-only compaction and rewind records are also informative:

- a compaction marker references a separately written checkpoint containing
  compacted conversation history, an exact prompt index, schema version, and
  selected supporting context;
- replay uses the checkpoint as a base and applies the surviving update suffix;
- a rewind marker changes the effective timeline without deleting old update
  lines; and
- fork copies and filters individual chat/update records, can rewrite Session
  IDs and working-directory data, and optionally truncates an incomplete tail.

Externalizing a large checkpoint keeps the log bounded, but the inspected
checkpoint write and marker append are only ordered messages, not one durable
cross-file transaction. A failed checkpoint write may therefore be followed by
a marker that references a missing file. Fork materialization also writes its
child files directly rather than publishing a fully synchronized staging
directory. Yakitori needs a stricter saga: durably publish an artifact first,
then append and synchronize its reference fact; orphaned artifacts can be
garbage-collected, while a committed fact must never point at an artifact that
was not published.

Finally, Grok's filesystem-aware SQLite helper confirms that WAL must not be
assumed safe on an arbitrary Session location. It uses WAL on local disks, but
selects a rollback journal and a per-host database on network mounts because
WAL's memory-mapped `-shm` and locking assumptions are unsafe there. The
per-host fallback is acceptable specifically because those databases are
rebuildable indexes and caches. This reinforces both parts of Yakitori's
direction: JSONL owns each Session's authoritative history, and any SQLite
Session projection remains disposable.

Relevant local sources:

- `.references/public/grok-build/crates/codegen/xai-grok-shell/src/session/storage/mod.rs`
- `.references/public/grok-build/crates/codegen/xai-grok-shell/src/session/storage/jsonl/mod.rs`
- `.references/public/grok-build/crates/codegen/xai-grok-shell/src/session/persistence.rs`
- `.references/public/grok-build/crates/codegen/xai-grok-shell/src/session/helpers/replay.rs`
- `.references/public/grok-build/crates/codegen/xai-chat-state/src/actor/state.rs`
- `.references/public/grok-build/crates/codegen/xai-chat-state/src/actor/mutations.rs`
- `.references/public/grok-build/crates/codegen/xai-grok-sampling-types/src/conversation.rs`
- `.references/public/grok-build/crates/codegen/xai-sqlite-journal/src/lib.rs`
- `.references/public/grok-build/crates/codegen/xai-chat-state/src/actor/tests.rs`

### OpenCode

The current reference is OpenCode v2 at commit
`4678bd104951dac0fd0cc5bc332e32722b7699fb`. The legacy
`packages/opencode` implementation is v1; the relevant v2 Session kernel lives
primarily in `packages/core`, `packages/schema`, `packages/protocol`, and
`packages/server`.

OpenCode v2 uses one installation-wide SQLite database as both its canonical
event store and its transactional projection store. The durable event tables
are approximately:

```text
event_sequence
  aggregate_id primary key
  seq
  owner_id nullable

event
  id primary key
  aggregate_id
  seq
  created
  type       // for example session.tool.success.1
  data       // JSON payload

unique (aggregate_id, seq)
```

Each durable event definition declares its aggregate field and schema version.
The in-memory envelope adds `id`, `created`, `aggregateID`, `seq`, and
`version`; the database stores the version by suffixing it to `type`. This is a
stronger fact identity and logical-coordinate design than Kimi Code's current
wire records, and it closely matches the candidate Yakitori envelope.

Publishing one durable event opens an immediate SQLite transaction and, inside
that same transaction:

1. reads the aggregate's latest sequence and validates ownership;
2. assigns the next gap-free sequence;
3. runs all registered synchronous projectors;
4. runs an optional operation-specific commit hook;
5. advances `event_sequence`; and
6. inserts the event row.

Only after commit does it notify live listeners. A projector failure therefore
rolls back the event, sequence, and projected rows together. This is OpenCode's
most important strength: the event log, `session_message`, `session_pending`,
instruction state, and aggregate metadata cannot normally become transactionally
out of sync.

The same strength explains why the design should not be copied wholesale into
Yakitori's JSONL Session lane. OpenCode relies on SQLite to make one event and
all of its local projections one atomic commit. A JSONL-first kernel must make
JSONL authoritative and allow its disposable SQLite projection to lag. It
cannot reproduce this transaction across the file and database without
creating two-phase-commit complexity.

OpenCode normally commits one event per transaction rather than a batch of
events. A high-level action such as promoting several steered inputs publishes
several independent `session.input.promoted` events. This is useful evidence
for complete-prefix semantics: the product already treats each fact as an
independent durable boundary even though SQLite could have offered a larger
transaction.

Durable input admission is particularly strong. `session.input.admitted` and a
row in the pending inbox are committed together. Execution is only woken after
that commit. The runner later publishes `session.input.promoted`; its projector
deletes the pending row and creates the visible user or synthetic message in
the same event transaction. Consequently, a restart sees either pending work
or a promoted message, not an untracked gap between them.

Input idempotency is domain-specific rather than a generic operation receipt.
The caller supplies a stable message ID. An exact retry reconciles with either
the still-pending row or the already-promoted message plus its original
admission event. Reusing the ID with a different Session, prompt, metadata, or
delivery mode fails. This is a valuable model for Yakitori's `input.admitted`
operation receipt even though other OpenCode commands do not all have the same
retry contract.

The read side has two useful cursor models:

- the durable event stream reads `after seq` in bounded SQL pages, captures a
  replay watermark, emits a `log.synced` marker, and subscribes before the
  historical read so commits during replay are picked up afterward; and
- Session and message APIs paginate through indexed projection rows using
  stable Session/Message IDs plus time or projected sequence.

This is the cleanest reference for the proposed Yakitori combination of a
logical fact cursor and a paginated read projection. JSONL byte offsets remain
an internal projector checkpoint; public catch-up uses `seq`, and UI pages use
stable entity boundaries.

OpenCode also distinguishes ephemeral stream data from durable facts well:

- text, reasoning, and Tool-input deltas are live-only;
- their completed full values are durable;
- `session.step.started`, `.ended`, and `.failed` delimit one logical LLM call;
- `session.tool.called` is durable before a local Tool fiber is started;
- bounded semantic Tool progress may be durable; and
- Tool success or failure is a separate terminal event.

The naming is more precise than calling every model invocation a Turn.
OpenCode explicitly reserves Turn for a future assistant-level unit that may
contain several Steps. Yakitori should likewise distinguish a provider Step
from the user-visible Turn.

The Tool state machine is still not complete enough to copy verbatim. Durable
terminal types are primarily success and failed. Cancellation, permission
decline, interruption, and unknown post-crash side-effect state are often
represented through an `aborted` error. The `executed` flag means the provider
executed the Tool, not that a local host side effect definitely began. On the
next drain, OpenCode scans projected streaming/running Tools and appends a
failed/aborted result. That makes provider context usable but can overstate
what is known about an external side effect. Yakitori should retain the
incomplete canonical Tool and, if desired, append a recovery observation whose
side-effect outcome remains unknown.

Permission handling is a more serious mismatch. Permission requests and
replies are ephemeral events backed by an in-memory pending map; shutdown fails
the deferred requests as declined. Saved allow rules persist separately, but
the request and decision audit trail does not. Yakitori must continue recording
permission requested and resolved as durable Session facts with stable actor
identity.

Compaction is append-oriented. OpenCode records admitted, started, ended, and
failed facts; stream deltas remain ephemeral. The completed event contains the
summary plus retained recent context, and model-context loading begins at the
latest completed compaction projection. Raw event history remains present.
This supports the same basic conclusion as Kimi Code, although OpenCode does
not yet record an explicit `throughSeq` in the compaction payload and stores the
large summary inline.

Fork is unusually revealing. It records an exact `parentSeq`, but does not copy
the parent's raw event prefix into the child's event aggregate. Instead, the
fork projector copies parent `session_message` rows, remaps Message IDs, stores
fork lineage, reserves the inherited sequence range, and lets new child events
start after that range. Some instruction reconstruction recursively reads the
parent event lineage. The result gives efficient fork and stable pagination,
but a child's event log is not a self-contained authoritative history. This is
appropriate for one transactional database; it is not the desired property of
an independently portable per-Session JSONL file.

Revert similarly appends staged, cleared, and committed events while the
committed projector deletes effective message and pending rows after the chosen
boundary. The old event suffix remains. This is a good example of separating
recorded history from the effective timeline, but its filesystem snapshot
restore occurs before the durable staged event and therefore remains a
cross-resource saga rather than one atomic operation.

Large Tool output is bounded to 2,000 lines or 50 KiB for model-visible and
durable content. The full text is written to a managed file and a path marker
is retained. Those files are not content-addressed, are not synchronized before
the fact, and are cleaned after seven days. This is a useful context-bounding
mechanism, not a durable artifact store. Yakitori still needs hash, length,
media type, durable publication, authorization, and reachability-based
retention.

There are several additional limits in the generic event layer:

- SQLite is configured for WAL with `synchronous = NORMAL`, favoring latency
  over the strongest sudden-power-loss durability;
- one global database means unrelated Sessions share its writer and failure
  domain;
- `log()` skips event types absent from the current durable manifest while
  advancing the cursor, but explicit replay rejects unknown types;
- event `metadata` and `location` are not stored in the event table even though
  an inline projector can use them, so every projection is not strictly
  reproducible from serialized event rows alone; and
- schema versions exist, but current migration relies substantially on global
  SQL migrations and exact-version projector registration rather than an
  opaque, per-fact streaming upcaster.

OpenCode therefore remains a primary reference for server boundaries, durable
admission, domain idempotency, fact taxonomy, synchronous projection rules,
sequenced catch-up, and indexed pagination. Its global SQLite event log is not
the target for Yakitori's single-writer Session transcript. Reference products
should inform different boundaries rather than define one inherited storage
architecture.

Relevant local sources:

- `.references/public/opencode-v2/packages/core/src/event.ts`
- `.references/public/opencode-v2/packages/core/src/event/sql.ts`
- `.references/public/opencode-v2/packages/schema/src/session-event.ts`
- `.references/public/opencode-v2/packages/core/src/session/pending.ts`
- `.references/public/opencode-v2/packages/core/src/session/projector.ts`
- `.references/public/opencode-v2/packages/core/src/session/runner/llm.ts`
- `.references/public/opencode-v2/packages/core/src/session/compaction.ts`
- `.references/public/opencode-v2/packages/core/src/tool-output-store.ts`

## Consolidated Codex Takeaways

The main Codex lesson is not merely that it uses JSONL. Its stronger pattern is
one authoritative ordered history feeding several purpose-specific reducers:

```text
canonical Session facts
-> Runtime recovery
-> model-context reconstruction
-> Turn and Item history projection
-> Session summary projection
-> fork and compaction processing
```

Yakitori should adopt the following parts of that architecture:

- Keep one authoritative append-oriented Session history and make every other
  Session representation explicitly rebuildable.
- Give every durable line a stable logical coordinate. Use `seq` for ordering,
  pagination, fork boundaries, and diagnostics; use byte offsets only as
  physical checkpoints for incremental readers.
- Separate durable facts from transient streaming updates. Persist lifecycle
  boundaries, completed observations, context baselines, permission decisions,
  and compaction checkpoints; do not persist every delta or progress signal.
- Build several narrow reducers rather than making the JSONL schema equal to a
  GUI transcript or provider request format.
- Project canonical Turn and Item records incrementally into SQLite for
  paginated reads. Commit the projected rows and the next JSONL offset and
  sequence in one SQLite transaction so the projection may lag the journal but
  can never claim to have consumed data it did not materialize.
- Preserve the first sequence at which a projected Turn or Item appeared while
  allowing a later fact to update its latest snapshot. This keeps pagination
  order stable as an Item develops.
- Make compaction a self-contained recovery checkpoint. A bounded reverse scan
  needs both replacement model history and the execution/context baseline
  required to interpret the surviving suffix.
- Treat fork as selection and normalization of a precise fact prefix rather
  than byte-for-byte file copying. Support exact `throughSeq` and stable Turn
  boundaries, and record `forkedFrom: { sessionId, throughSeq }` in the child.
- Preserve incomplete Turns and Tools honestly. The absence of a terminal fact
  is a real recoverable state, not permission to synthesize failure.

The likely read-side shape is:

```text
session_projection_state
  session_id
  next_seq
  next_byte_offset

session_turns
  session_id
  turn_id
  start_seq
  terminal_seq nullable
  status

session_items
  session_id
  turn_id
  item_id
  first_seq
  latest_seq
  item_json
```

Pagination cursors should be opaque API values anchored to a Session, a scope
such as Turns or Items, and a logical sequence. They must not expose a JSONL
byte offset because migration, rewriting, or physical compaction may change
offsets without changing logical history.

Yakitori should not copy these Codex details without a separate justification:

- long-lived legacy and paginated formats selected by a product mode; prefer a
  clear Session history `formatVersion` and an explicit migration path;
- duplicate model-protocol and product-Item records when one Yakitori fact can
  losslessly support both reducers;
- file `flush` as a durability guarantee; Yakitori still requires grouped
  multi-line `writeAll` followed by one file synchronization;
- recovery that skips arbitrary malformed newline-terminated records; only a
  final unterminated fragment is the normal torn-tail case;
- rollback markers that force later readers to reinterpret an old suffix;
  prefer a forked execution lane unless a real multiple-head requirement
  appears; and
- automatically appending a synthetic interruption when forking an active
  Turn. Yakitori should expose an explicit policy such as exact `throughSeq`,
  terminal `throughTurnId`, last stable boundary, or include incomplete tail.

This suggests the following implementation sequence if the fact-line strategy
is eventually accepted:

1. land one durable fact per line, gap-free Session `seq`, grouped write plus
   sync, and complete-prefix recovery;
2. define the durable fact taxonomy and independent reducers;
3. add the SQLite offset/sequence checkpoint and paginated Turn/Item read
   projection;
4. add `TurnContext`-equivalent baselines and self-contained compaction
   checkpoints;
5. add exact-boundary fork normalization; and
6. add streaming schema migration and history-rewrite tooling after the
   boundaries above have concrete callers.

## Consolidated Grok Build Takeaways

Grok strengthens the case for per-Session JSONL, but its most valuable lesson
is not its exact file layout. It shows which failure boundaries appear once a
small-record replay stream coexists with caches, external checkpoint files,
provider constraints, and live writes.

Yakitori should adopt or preserve these ideas:

- Keep one in-process persistence owner per Session. Retain a lightweight
  exclusive ownership or append lock as defense against two server processes;
  one active Turn alone does not prove one file descriptor owns the journal.
- Serialize every fact as one complete newline-terminated record, while still
  permitting several records to share one `writeAll` and synchronization
  barrier.
- Make the durability API report whether an error happened before commit,
  after commit, or after the caller lost acknowledgement. Reconcile ambiguous
  outcomes by fact ID or operation receipt instead of retrying blindly.
- Do not acknowledge admission of an input, permission decision, or
  side-effect boundary until its fact is durable. A buffered streaming path may
  exist only for information whose loss is explicitly acceptable.
- Synchronize the parent directory when first publishing a Session journal or
  an external artifact. On macOS, account for the distinction between ordinary
  sync and the stronger full-storage barrier when the product promises
  durability across sudden power loss.
- Load a live Session with a snapshot-plus-barrier-plus-delta protocol so facts
  appended during reconstruction are neither missed nor duplicated.
- Keep byte offsets as local optimization coordinates and `(sessionId, seq)` as
  logical coordinates. Persist both in a disposable projection checkpoint.
- Evolve schemas through explicit envelope and fact versions plus read-side
  normalization. Old canonical records do not need to be rewritten merely
  because the current reducer has a newer representation.
- Publish large compaction payloads and Tool results as durable artifacts before
  appending facts that reference them. Treat the cross-file operation as a
  recoverable saga with orphan cleanup.
- Keep SQLite projections rebuildable and filesystem-aware. Never rely on WAL
  over a network mount without an explicit storage contract.

Yakitori should intentionally reject these Grok behaviors:

- ordinary replay updates that are described as durable but normally receive
  only a process-level flush;
- treating a timestamp, nested protocol event ID, or byte offset as the
  canonical Session ordinal;
- silently skipping malformed newline-terminated records and continuing with
  later history;
- converting a torn tail into a permanent corrupt interior line on the next
  append;
- allowing `chat_history.jsonl`, summary files, and the update stream to drift
  into competing sources of truth;
- inferring fundamental Turn boundaries only from chunks and prompt-index
  heuristics;
- persisting synthetic cancelled Tool results merely to satisfy a provider's
  request schema;
- recording a checkpoint reference before the checkpoint artifact is known to
  be durable; and
- copying a fork into directly visible child files without a durable staging
  and publication boundary.

The combined Codex and Grok direction is therefore:

```text
canonical Session JSONL
  one fact per line
  gap-free logical seq
  grouped write + one sync
  strict complete-prefix recovery
        |
        +-> runtime reducer
        +-> bounded provider-context normalizer
        +-> paginated SQLite Turn/Item projection
        +-> summary cache
        +-> fork/compaction/migration tools
```

Codex is the stronger reference for canonical logical coordinates, context
reconstruction, and read-side pagination. Grok is the stronger reference for
commit-aware append errors, parent-directory durability, live snapshot/delta
catch-up, and concrete cross-file failure modes. Neither should define
Yakitori's fact taxonomy verbatim.

## Consolidated Kimi Code Takeaways

The current Kimi Code mainline gives the strongest direct implementation
evidence for the proposed physical write strategy:

```text
typed operation  -> one JSONL line
pending operations -> one joined byte buffer
joined buffer -> one append + one file sync
crash recovery -> every valid complete-line prefix
```

Yakitori should adopt these Kimi ideas:

- align one authoritative execution log with one Agent or Mate execution lane,
  rather than allowing several Agents to write one Session file;
- define persisted operations through typed schemas and pure reducers, and mark
  transient streaming events explicitly non-persistent;
- serialize each logical fact independently while coalescing pending lines into
  one synchronized physical append;
- treat append errors as ambiguous unless storage can prove whether the bytes
  committed, and never automatically duplicate a possibly committed suffix;
- reject malformed newline-terminated interior records while treating only a
  final unterminated fragment as the normal torn-tail case;
- publish content-addressed artifacts before appending facts that reference
  them;
- preserve incomplete Tool calls in canonical history and satisfy provider
  pairing requirements only in a derived, explicitly synthetic context view;
- represent compaction as append-only lifecycle and context-application facts
  while retaining raw history;
- flush a live source before forking and atomically publish the child log; and
- combine Turn-oriented API pagination with an offset-driven rebuildable search
  or history projection.

Yakitori should intentionally strengthen or reject these Kimi behaviors:

- publishing a reduced operation or starting a Tool before the corresponding
  append has crossed a durability barrier;
- reopening append mode after ignoring, but not truncating and syncing, a torn
  final fragment;
- relying on one file-level protocol version without stable fact IDs, a
  gap-detecting Session sequence, or per-fact schema versions;
- skipping unknown or invalid operation records during authoritative replay;
- collecting a whole migrated log in memory before rewrite;
- collapsing Tool cancellation, interruption, permission decline, execution
  failure, and unknown post-crash outcome into `isError` plus text;
- deriving all Turn lifecycle boundaries from prompt and loop records rather
  than witnessing the boundaries the product needs to inspect;
- copying a whole source history with only a parent Session ID instead of an
  exact `throughSeq`; and
- rebuilding the complete transcript merely to serve one cold history page.

The references now divide cleanly by strength:

| Concern | Strongest reference | Yakitori adjustment |
| --- | --- | --- |
| Logical fact and reducer shape | Codex, Kimi Code, and OpenCode | Keep one independently meaningful fact per record |
| Stable envelope and aggregate sequence | OpenCode | Translate its event ID, `seq`, and version to JSONL |
| Grouped multi-line append | Kimi Code | Await sync before admission or side effects |
| Ambiguous append outcomes | Grok Build and Kimi Code | Reconcile by operation receipt and exact prefix |
| Durable input admission | OpenCode | Sync `input.admitted` before wake and reconcile exact retries |
| Context reconstruction | Codex | Keep execution/context baselines explicit |
| Append-only compaction | Kimi Code | Add exact covered sequence and artifact discipline |
| Fork source boundary | OpenCode and Kimi Code | Materialize a self-contained child through exact `throughSeq` |
| Paginated history | Codex, OpenCode, and Kimi transcript | Back with incremental SQLite Turn/Item projection |
| Artifact-before-fact ordering | Kimi Code | Generalize from media to large Tool output |

## Consolidated OpenCode v2 Takeaways

OpenCode's strongest contribution is not an argument that Yakitori should keep
Session history in SQLite. It demonstrates the behavioral contracts that a
JSONL authority and a lagging SQLite read model must preserve separately:

```text
OpenCode transaction
  durable event
  + gap-free aggregate seq
  + inbox or message projection mutation
  + operational commit hook
  -> commit
  -> notify

Yakitori translation
  durable fact line(s) + sync
  -> acknowledge admission / cross side-effect boundary
  -> apply runtime reducer and notify
  -> transactionally advance disposable SQLite projection + cursor
```

Yakitori should adopt these OpenCode ideas:

- use a stable fact ID, per-Session gap-free sequence, explicit fact version,
  and strict aggregate validation;
- separate durable facts from ephemeral stream deltas and persist completed
  bounded values rather than every token;
- durably admit user and synthetic inputs before advisory execution wakeup;
- reconcile exact retries by caller-supplied identity and a payload
  fingerprint, including retries after the input has left the pending inbox;
- consume pending input and materialize its visible message at one logical safe
  boundary;
- record Tool call admission before starting a local external effect;
- model one provider request as a Step and reserve Turn for the larger
  user-visible execution unit;
- expose replay-then-follow with a captured sequence watermark and explicit
  synchronized marker;
- paginate Session and Message projections by stable IDs backed by logical
  sequence indexes;
- record fork source sequence explicitly; and
- keep compaction and revert as recorded facts whose reducers change effective
  context without erasing canonical history.

Yakitori should intentionally reject or strengthen these OpenCode behaviors:

- making a global SQLite event table the canonical execution history for every
  Session;
- assuming an inline event/projector transaction can be reproduced across a
  JSONL file and SQLite read model;
- notifying an accepted operation without a generic reconciliation path for an
  acknowledgement-lost outcome;
- skipping unknown canonical event types in normal reads and rejecting them in
  replay instead of retaining opaque facts;
- omitting envelope metadata that a projector used, thereby preventing an
  identical rebuild from event rows alone;
- persisting permission requests and decisions only as volatile process state;
- converting every recovered incomplete Tool to failed/aborted without an
  explicit recovery-observation or unknown side-effect state;
- treating a provider-executed boolean as evidence that a local side effect did
  or did not begin;
- storing expiring filesystem paths as if they were durable Tool artifacts;
- forking by copying projection rows while leaving the child aggregate's raw
  history dependent on parent lineage; and
- relying on WAL `synchronous = NORMAL` when the Session API promises the
  strongest acknowledged durability.

OpenCode also clarifies one point about fact-line atomicity. Its event layer
could group many facts in one SQLite transaction, but most Session workflows
publish them as independent event transactions. Input admission, promotion,
Step start, Tool call, Tool result, and Step end may all form valid prefixes.
The useful atomic unit is usually one fact plus the operational state necessary
to make that fact actionable, not the whole command's eventual event list.
Yakitori's JSONL design should preserve the same semantic prefixes while using
operation receipts and recoverable sagas for cross-fact workflows.

## Candidate Fact-Line Envelope

The current candidate keeps storage metadata separate from domain payload:

```ts
type StoredSessionFact = {
  readonly record: "fact"
  readonly formatVersion: 1
  readonly id: string
  readonly sessionId: string
  readonly seq: number
  readonly recordedAt: string
  readonly type: string
  readonly factVersion: number
  readonly data: JsonObject
  readonly operation?: {
    readonly id: string
    readonly fingerprint: string
  }
}
```

Field roles:

- `formatVersion` versions the storage envelope.
- `factVersion` versions the payload for one fact type.
- `seq` is the stable logical coordinate and remains strictly increasing and
  gap-free within a Session.
- Byte offsets are physical coordinates and belong in a rebuildable index, not
  in the JSONL line.
- `operation` is an optional idempotency receipt. The current candidate binds a
  receipt to one coarse fact; multi-fact idempotent operations need a separately
  designed saga rather than an implicit batch transaction.
- Domain actor IDs, entity relationships, and typed causes belong in the
  relevant fact payload. Display names and free-form metadata cannot decide
  authorization or routing.

The envelope must not persist projection fields such as `active`, `pending`,
`status`, derived Item IDs, aggregate counts, or `updatedAt`.

## Candidate Fact Granularity

Changing the physical format is insufficient if current event boundaries still
assume batch atomicity. Every complete prefix must be meaningful to replay.

One important candidate change is to persist one provider response as a coarse
fact containing its completed assistant outputs, Tool calls, provider response
identity, stop reason, and per-call usage. This avoids mechanically splitting
one observed response into an assistant-message line followed by an arbitrary
prefix of Tool-call lines. Consumer-facing Message, Item, and Tool views remain
derived.

Candidate fact families for further discussion are:

```text
session.created
input.admitted
input.cancelled

turn.started
turn.completed
turn.failed
turn.cancelled
turn.interrupted

model.response

permission.requested
permission.resolved

tool.execution.started
tool.result

context.compacted
```

`tool.execution.started` would record the important side-effect boundary. A
Tool call with no execution fact differs from a Tool whose side effect started
but whose result was never recorded. A terminal Tool outcome may need to
distinguish success, failure, permission decline, cancellation, and an observed
interruption. Recovery must not manufacture any of these outcomes merely
because a process restarted.

## Candidate Write Semantics

1. A per-Session owner/gate materializes immutable fact envelopes with assigned
   IDs and consecutive sequences.
2. The reducer validates facts incrementally so every prefix is representable.
3. Each fact is serialized independently with a trailing newline.
4. One or more serialized lines are joined into one buffer.
5. The writer passes the buffer through `writeAll`, which may need several
   underlying writes to handle short writes.
6. The writer synchronizes the file once for the buffer.
7. Only after a successful synchronization does the normal path advance
   in-memory and SQLite projections or publish facts to subscribers.
8. Creating a new journal also requires the appropriate directory durability
   steps.

If the process crashes during the buffer, recovery may observe zero through all
of its complete lines. The complete prefix is retained; only the final
unterminated fragment is repaired. An in-process write or sync error remains
ambiguous until the handle is reopened, the complete prefix is reconciled, and
the retained bytes are synchronized successfully.

Single-writer is a topology rule, but the implementation should still retain a
lightweight runtime ownership lock so two accidentally launched server
processes cannot both open the same Session store.

## Candidate Read and Repair Semantics

- Read raw bytes and split on newline so invalid UTF-8 in a torn tail does not
  poison the whole file.
- Track each complete line's start and end offset while validating its Session
  ID and sequence.
- Ignore and later truncate only an unterminated final fragment.
- Treat a malformed newline-terminated line, Session mismatch, duplicate
  sequence, or sequence gap as committed corruption rather than silently
  deleting evidence.
- Preserve an unknown fact type as an opaque fact and advance the sequence.
- Dispatch known facts by `(type, factVersion)` and perform bounded in-memory
  upgrades. Do not rewrite canonical history merely because a new reader can
  normalize an older schema.

An incomplete Turn or Tool remains visible in the projection. Runtime liveness
may label it inactive or incomplete after restart, but liveness is not a
durable failure fact.

## Rebuildable SQLite Index

A future SQLite read model may contain mappings such as:

```text
(session_id, seq) -> (file_generation, start_offset, end_offset, fact_id, type)
projection_cursor -> (session_id, applied_seq, applied_offset, projection_version)
operation_receipt -> (session_id, operation_id, fingerprint, fact_seq)
session_summary -> rebuildable listing fields
```

The ordering rule is always:

```text
JSONL write and sync
-> SQLite transaction advances indexes and projections
```

If the process stops between those steps, SQLite is behind and replays the
JSONL suffix. SQLite must never be allowed to get ahead of the canonical
journal.

## Artifact References

Large Tool output should be stored outside the JSONL. A fact reference will
likely need at least:

```ts
type ArtifactReference = {
  readonly artifactId: string
  readonly mediaType: string
  readonly byteLength: number
  readonly sha256: string
  readonly preview?: string
  readonly truncated: boolean
}
```

The eventual design also needs authorization, deletion, reachability-based
garbage collection, and honest behavior when an artifact is missing.

## Fork, Rewind, and Compaction Questions

A child Session should record an exact source boundary:

```ts
forkedFrom: {
  readonly sessionId: string
  readonly throughSeq: number
}
```

Materializing a child may filter facts, migrate their schemas, rewrite
Session-local IDs, and assign a new consecutive sequence. It must not mutate
the source Session. Whether rewritten facts also preserve `sourceFactId`
provenance remains open.

Compaction should distinguish model-context recovery from authoritative Session
history. One candidate is an append-only `context.compacted` fact that records
the exact source boundary and a bounded context checkpoint while raw facts
remain available for inspection and projection repair.

Rewind may be represented as a new forked execution lane rather than deleting
history. The same-Session branching alternative needs an explicit head/branch
model before it can be selected.

## Open Questions Before a Decision

1. What is the canonical semantic fact for one provider response: one complete
   response, individual provider items, or another boundary?
2. Which Tool observations deserve durable facts, and which statuses remain
   read-side projections?
3. Must operation receipts remain single-fact, or does a concrete multi-fact
   idempotent caller justify saga support now?
4. Should a fully newline-terminated but semantically invalid tail be treated
   as corruption, quarantined, or repaired under a narrower rule?
5. What exact compaction fact is sufficient for bounded model-context recovery
   without persisting an accidental second Session projection?
6. Is rewind always a fork, or will the product need multiple heads inside one
   Session?
7. How should artifact retention interact with fork, deletion, and memory
   privacy?
8. What are the exact current Claude Code transcript and recovery formats?
9. Which Kimi-style operations should become Yakitori facts, and which remain
   transient runtime events or provider-context compatibility projections?
10. Which Codex rollout items are canonical history versus UI/debugging records,
    especially around compaction and tool lifecycle?
11. Which OpenCode-style inline projector guarantees need an explicit JSONL
    saga or operation receipt, and which can safely become eventually
    consistent read projections?
12. How should legacy `{ record: "commit", events: [...] }` lines participate
    in streaming reads, fork rewriting, and optional one-way migration?

## Decision Gate

Once the product comparisons and open questions are resolved:

1. add a new numbered ADR that explicitly accepts or rejects complete-prefix
   fact-line recovery;
2. mark decision 0008 as superseded if the fact-line strategy is selected;
3. update `docs/architecture.md` and `AGENTS.md` together;
4. change fact granularity before removing the commit wrapper if any current
   command still depends on batch atomicity; and
5. implement the storage migration with focused byte-cut, replay, fork,
   migration, artifact, and projection-rebuild tests.
