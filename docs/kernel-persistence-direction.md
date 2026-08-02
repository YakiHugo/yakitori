# Kernel Persistence Direction

Status: living direction document; the settled direction for Session kernel
persistence. Decision 0009 is authoritative for the implemented per-fact
journal format. Its stage plan is archived at
`docs/archive/stage-2-fact-journal.md`.
Last updated: 2026-07-30

This document records the settled direction for Session kernel persistence. It
consolidates the conclusions of the Session storage strategy research
(archived at `docs/archive/session-storage-strategy-research.md`) and the
parts of decisions 0007 and 0008 that remain in force. Individual capabilities
land through their own ADRs; this document states what is settled, what is
deferred, and what is rejected. The appendix keeps a source-verified
comparison of the reference products.

Decisions 0008 and 0009 remain authoritative for everything not restated here:
per-Session `events.jsonl` journals, the runtime lock, the per-Session I/O
gate, `summary.json` as a disposable listing cache, and advancing projections
only after sync.

## Settled Principles

### 1. Per-Session JSONL is the only canonical execution history

One execution Session has one logical writer. The per-Session JSONL journal is
the canonical transcript. SQLite stores relational data (Mates, Rooms, Tasks,
Messages, Deliveries) and may hold rebuildable Session indexes and
projections, but it must never become a second authoritative execution
history.

### 2. One fact per line

The durable unit is one complete fact line, not a kernel command batch. A
command may contribute several fact lines; they are serialized independently,
joined into one buffer, and admitted with one `writeAll` plus one file sync.
Only after the sync do projections advance and durable observations get
published. Unknown fact types are preserved opaquely on replay with `seq`
advancing normally; canonical history is never rewritten just because a newer
reader exists.

### 3. The fact envelope (best practice)

The envelope was verified field by field against the pinned sources of four
mature products (see the appendix). Conclusion: the existing event envelope is
already the right design with zero added fields — a fact line is the flat
serialization of the envelope, unwrapped:

```json
{"id":"event_…","sessionId":"session_…","seq":41,"version":1,"createdAt":"…","type":"tool.result","data":{…}}
```

| Field | Value | Verified practice |
|---|---|---|
| `id` | stable fact ID (`event_` prefix) | OpenCode: globally unique `evt_` ID doubling as the replay-reconciliation anchor; Claude Code: per-message `uuid`; Codex/Grok: none |
| `sessionId` | owning Session, in-line | Claude Code: stamped on every record; OpenCode: `aggregate_id` on every row; Codex: only in the first `session_meta` line; Grok: buried inside `params` |
| `seq` | strictly increasing, gap-free per Session | OpenCode: `(aggregate_id, seq)` uniqueness enforced transactionally; Codex: optional `ordinal`, Paginated mode only; Claude Code: `parentUuid` linked list; Grok: file order only |
| `createdAt` | ISO wall clock | all four; display/debug only, never ordering |
| `type` + `data` | flat type + JSON payload | same shape in all four; line kinds are folded into `type` as well (Claude Code's `summary`/`file-history-snapshot`/`queue-operation`, Codex's `session_meta`/`compacted`/`turn_context`) |
| `version` | per-type schema version, separate field | OpenCode folds it into the type suffix (`"session.idle.1"`); a separate field dispatches more cleanly on `(type, version)`; the two are equivalent |

Deviations from the four products, with reasons:

- **Gap-free `seq`; a gap is corruption.** Stricter than Codex (optional
  ordinal) and Claude Code (a linked list that permits branches), equal in
  strength to OpenCode's transactional uniqueness. Rationale: gap detection is
  the cheapest integrity signal under complete-prefix semantics, and `seq` is
  the single logical coordinate for fork boundaries, compaction boundaries,
  and pagination cursors.
- **`version` as a separate field rather than a type suffix.** Equivalent to
  OpenCode's suffix scheme; a separate field keeps parse dispatch cleaner.
- **No per-line app version.** Claude Code stamps the CLI `version` on every
  record as a debugging aid; our debugging needs are covered by the schema
  `version` and `createdAt`.
- **No framing wrapper.** None of the four has one. Legacy `commit` lines
  self-identify via their own `record` key (`record` becomes a framing-level
  reserved key that never appears in the fact whitelist). If a non-fact line
  kind is ever needed (e.g. a checkpoint marker), a new reserved key can be
  introduced then — old readers fail loudly on unknown reserved keys, which is
  exactly the strictness required, and the change stays backward compatible.
- **No envelope-level idempotency receipt field.** OpenCode's verified model
  is "the stored row is the receipt" — a replay reconciles by caller-supplied
  stable ID plus payload deep-equality: identical returns the recorded event,
  divergent is an error. We implement the same; see principle 6.

Fields deliberately not added: batch IDs / commit markers / per-batch item
counts (they would recreate batch transactions and defeat complete-prefix);
byte offsets (physical checkpoint data that belongs only in rebuildable
indexes, never in fact lines or public cursors); per-line checksums (none of
the four has them; newline framing + parse validation + `seq` continuity
suffice, and the integrity of large payloads belongs to the artifact
reference's sha256, not the line).

No hard cap on line length, but oversized payloads (large tool output) should
move to artifact references — see deferred items.

### 4. Complete-prefix durability

```text
logical durability unit    one complete fact line
physical I/O unit          one buffer containing one or more fact lines
durability barrier         one successful file sync for that buffer
recovery unit              the complete-line prefix present after restart
```

This deliberately abandons the zero-or-all-events batch recovery contract:
batch IDs and commit markers would recreate batch transactions and defeat the
purpose of small records.

### 5. Recovery rules

- Keep every complete fact line that reached the file. Only the final
  unterminated fragment is a torn tail.
- The torn tail is truncated and the file synced before appends resume; new
  appends never join an untruncated tail.
- In the committed prefix, a malformed newline-terminated line, a Session ID
  mismatch, a duplicate `seq`, or a `seq` gap is corruption and fails loudly.
  Silently skipping committed records is not acceptable in a canonical log.
- A Turn or Tool with an opening fact but no terminal fact is honest
  incomplete history. Recovery never fabricates closure facts;
  provider-shaped compatibility items exist only in the derived model-input
  view.
- Append errors are ambiguous and are triaged as NotCommitted / Committed /
  AckLost by re-reading the durable prefix and reconciling against fact IDs
  and the admission index — never by blind retry.

### 6. Idempotency reconciles at the domain level, not in the envelope

Callers supply a stable ID for commands that need idempotency (today:
`admitInput`'s `requestId`). The store rebuilds the reconciliation index from
in-line data while reading the journal (`input.admitted` facts indexed by
`data.requestId`, together with payload fingerprints) and maintains it on
append:

- same ID, same payload → return the already-recorded fact (retry-safe,
  including retries after AckLost);
- same ID, different payload → error (ID reuse);
- duplicate IDs in the journal → corruption (a correct writer never produces
  one).

This is OpenCode v2's verified "the stored row is the receipt" model, which
keeps the envelope free of extra fields. Multi-fact idempotent workflows need
an explicitly designed saga when a real caller appears; batch transactions
must not be smuggled back in.

### 7. Tool results stay deliberately coarse

`tool.result` keeps the coarse shape `{ content, output?, error? }` — success
is the absence of `error`, failure carries an `error` with a code and a
message. This is a deliberate choice shared by the mature products, and the
reasoning holds:

- The primary consumer of a tool result is the model, and the provider's
  tool_result shape is the binary `{ content, is_error }`; a finer enum is
  invisible to the model. Nuance can only travel through the error string,
  and the model reads strings well enough.
- The system itself does not branch on failure kinds (no retry, rollback, or
  scheduling logic consumes it); an enum no consumer distinguishes is dead
  data.
- Consistent with "the kernel is a witness, not a judge" (decision 0007):
  when the model can see the violation and compensate, record honestly rather
  than classify finely.

The strictness that actually matters lives in two honesty invariants, neither
of which is in the tool.result enum:

1. **Terminal facts must be observed.** Whether a tool's side effect happened
   before a crash is fundamentally unknowable; persisting an unobserved
   "cancelled/failed" is guessing (Grok does this — it is the counterexample).
   The honest record is "still open"; provider-shaped compatibility results
   are synthesized, explicitly marked, only in the derived model-input view.
2. **Permission decisions must be reconstructible.** `permission.requested` /
   `permission.resolved` are standalone durable facts (OpenCode keeps
   permissions ephemeral — after a restart it cannot answer "what did the
   user approve?", a hard problem for persistent Mates and an approvals UI).
   A permission-denied "tool never ran" is expressed jointly by the
   permission facts and a tool.result carrying a truthful `error.code` (e.g.
   `permission_denied`, with a message stating "No process was started"),
   and is fully reconstructible without a finer enum.

### 8. Durability ordering across resources

- JSONL first, everything else second: any rebuildable index (SQLite or
  `summary.json`) is written only after the journal sync, and replays the
  journal suffix when it falls behind. Indexes never get ahead of the
  journal.
- Artifact-before-fact (when artifact storage lands): a large payload is
  published durably first; the referring fact is appended only after. Orphan
  artifacts are garbage-collectible; a durable fact must never reference an
  unpublished artifact.
- No admission acknowledgement, event publication, or tool side effect
  crosses its boundary before the relevant durability barrier.

## Storage Layout

### File structure

```text
.yakitori/
└─ sessions/
   ├─ runtime.lock        # cross-process writer ownership (decision 0008)
   └─ <sessionId>/
      ├─ events.jsonl     # the only authoritative fact journal (append-only)
      ├─ summary.json     # disposable listing cache (temp file + rename + directory sync)
      └─ artifacts/       # reserved: content-addressed large payloads (lands with the artifact stage)
```

- One directory per Session: filesystem-level isolation, deletion is removing
  one directory, and a natural home for per-Session side files (cache, future
  artifacts).
- Creation protocol: `mkdir(0700)` → `open("a+", 0600)` → `syncDirectory`
  level by level (Session directory, sessions directory, its parent — each
  synced when newly created).
- `events.jsonl` is the only authoritative file; `summary.json` reconciles by
  `journalBytes` and is rebuilt on mismatch.
- No segmentation or rotation: segments would introduce a second durability
  domain ("which segment is current?") with no caller today; reassess when
  compaction wants prefix truncation.

Layout rationale (against the verified sources of the four products):

- **Root scoping.** All four use a global home (Codex `~/.codex`, OpenCode
  XDG, Grok `~/.grok`, Claude Code `~/.claude`) to serve cross-project resume
  UX; Grok and Claude Code both group by encoded cwd inside the global root —
  the market has converged on "group by project". We put the root inside the
  project (`.yakitori/`), which is equivalent and more thorough: the project
  is the aggregate root (Mates, memory, and Rooms are project-level
  concepts), deleting the project deletes its data with no global orphans,
  and the runtime lock is naturally per-project. The acknowledged cost: no
  cross-project Session listing, which v1 does not need.
- **One directory per Session vs one file per Session.** Codex and Claude
  Code use one file, embedding timestamps in filenames (plus Codex's date
  partitions) so `ls` alone can list and archive, at the cost of placing
  derived files elsewhere. Grok uses one directory: derived files co-locate,
  inner filenames are fixed, deletion is one `rm -rf`. We choose the
  directory because we have per-Session derived files (`summary.json`,
  future `artifacts/` and checkpoints) — Grok is the only product that keeps
  derived metadata inside the Session directory, which validates the
  co-located `summary.json`.
- **Naming.** We use opaque sessionIds; `ls` cannot sort them and listing
  relies on the summary cache. Grok uses UUIDv7 (time-sortable IDs) and gets
  both; if `ls`-sortability ever matters we can switch, it is not worth it
  now.
- **Locking.** The products rely on SQLite WAL or flock; we have no
  database, so the `runtime.lock` file is the closest analogue to OpenCode's
  directory locks (decision 0008).
- Honesty note: the Kimi layout cited in the research doc (including
  per-agent `blobs/`) has no source in the local reference repositories and
  is unverified; the reserved `artifacts/` shape is grounded in Claude Code's
  `image-cache/<sessionId>/` and Grok's co-located derived files instead.

### Line encoding

- One JSON value per line, `\n`-terminated, UTF-8, compact; `JSON.stringify`
  guarantees no raw newlines inside a line. All four products use compact
  single-line JSON.
- `record` is a framing-level reserved key: a line containing it is validated
  as a legacy `commit` record (present only for read compatibility); anything
  else goes to the fact validator. Both branches are strict-whitelist, total
  decisions — no field-presence guessing. Unknown `record` values are
  corruption. Framing-level strictness and fact-level opacity are two
  separate layers: unknown fact types are preserved opaquely; unknown line
  kinds fail.
- A command's fact lines are serialized, joined into one buffer, and admitted
  with one `writeAll` (handling short writes) plus one file sync.

### Payload design (the discipline of `data`)

- Record completed values only, never deltas: streaming deltas belong to the
  transient hub and are never persisted (OpenCode's durable/ephemeral split;
  already implemented here).
- Domain data only, no projection fields: derived state such as
  `active`/`pending`/`status`/counts/`updatedAt` is never persisted.
- Correlate by ID, not position: `turnId`/`toolCallId`/`inputId` and other
  stable prefixed IDs reference each other; timestamps and array positions
  are never used for correlation (`seq` is an envelope field and not part of
  this rule).
- Provider-neutral content blocks, with provider-specific extras carried in
  the open `providerMetadata` object rather than promoted to first-class
  fields.
- Errors are shaped `{ code, message }`: the code is stable for tooling to
  branch on; the message is for the model and for humans.
- Plain JSON values: no Dates or class instances; `structuredClone` and JSON
  round-trips are lossless.
- Large payloads (future): `{ preview, truncated: true, artifactRef: {
  sha256, byteLength, mediaType } }`, with the artifact published first
  (principle 8).

## Deferred Capabilities and Their Triggers

Each item below is directionally agreed but lands only when its trigger
produces a real caller, via its own ADR or an amendment to this document:

- **Content-addressed artifact store for large tool output** — the fact keeps
  a bounded preview, integrity metadata (sha256, byte length, media type),
  and a reference. Trigger: journal bloat from inline tool output (facts can
  already inline ~1 MiB today, and cold-start recovery reads whole journals
  into memory). Highest priority among the deferred items.
- **Rebuildable SQLite seq/offset index and paginated Turn/Item projection** —
  `(sessionId, seq) -> offset`, plus a projection cursor committing rows and
  the next seq/offset in one transaction. Trigger: the Room/Delivery stage
  needs relational pagination that the in-memory projection and
  `summary.json` cannot serve.
- **Compaction facts** — landed: an append-only `context.compacted` fact
  records the exact source boundary (`throughSeq` + cumulative
  `coveredTurnIds`) plus a bounded, self-contained checkpoint; raw facts are
  retained. See decision 0011.
- **Exact-boundary fork** — a self-contained child journal recording
  `forkedFrom: { sessionId, throughSeq }`; flush-before-copy, staged child
  publication, selective fact rewriting with provenance. Trigger: a product
  fork/rewind feature.
- **Coarse `model.response` facts and a `tool.execution.started` side-effect
  boundary fact** — the former records one provider response (completed
  assistant output, tool calls, stop reason, usage) as one coarse fact; the
  latter explicitly marks the "side effect is about to start" boundary.
  Trigger: compaction or collaboration work that needs them; never as a rider
  on unrelated changes. This does not include a fine terminal-Tool-outcome
  taxonomy — see principle 7.
- **Legacy journal one-way rewrite tooling and corruption quarantine/repair
  tooling** — trigger: real operational need; otherwise strict corruption
  handling fails loudly by design.

## Rejected Approaches

Settled by the research comparison and source verification; restated here so
they are not re-litigated:

- Flush-without-sync as a durability barrier (Codex's recorder is a record
  layout reference, not a durability protocol).
- Silently skipping or quarantining malformed committed lines (Grok; Kimi
  reportedly does the same — unverified locally).
- Newline-first torn-tail repair that converts torn bytes into a committed
  malformed record (Grok).
- Persisting synthetic cancelled/failed Tool results to satisfy provider
  shape (Grok, OpenCode); the absence of a terminal fact must not become an
  asserted outcome.
- Appending a checkpoint/compaction marker before the referenced checkpoint
  is durable.
- Timestamps, nested IDs, linked lists, or byte offsets as ordering ordinals
  (Grok's second-resolution timestamps and Claude Code's `parentUuid` chain
  both fail to give a gap-free ordinal).
- A global SQLite database as the canonical event history (OpenCode v2's
  shape); there is no two-phase commit across file + database.
- Batch commit markers, batch IDs, or per-batch item counts in the journal.
- A fine-grained terminal Tool outcome taxonomy (first-class success /
  failure / permission-decline / cancellation / interruption enum) — no
  consumer; see principle 7.
- Framing wrappers (`record`/`formatVersion`) and envelope-level generic
  idempotency receipt fields — none of the four has an equivalent; line kinds
  use the reserved-key mechanism and idempotency uses domain reconciliation
  (principles 3 and 6).

## Governance

Changing this direction requires an ADR or an explicit amendment to this
document. The Session storage strategy research document is archived under
`docs/archive/` as a historical record; implement stage 2 from this direction
and the ADRs, not from the archived research.

## Appendix: Source-Verified Product Comparison

Everything below was verified against the pinned sources under
`.references/public/` (which are gitignored and must never become a runtime
dependency), except the Kimi section, which is marked unverified.

### Codex — record layout reference

- Structure: global `~/.codex/`; authoritative
  `sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`, one file per
  Session, date-partitioned; derived `state_5.sqlite` etc. flat under home
  (rebuilt from rollouts); `history.jsonl` with flock on the file itself.
  (`codex-rs/rollout/src/recorder.rs:1505-1530`,
  `codex-rs/state/src/lib.rs:100-104`)
- Line: `RolloutLine { timestamp, ordinal? }` + flattened `type`/`payload`
  (`codex-rs/protocol/src/protocol.rs:3359-3366`). `ordinal` is written only
  in Paginated history mode. No per-line id, sessionId, or schema version;
  variants (`session_meta`, `response_item`, `compacted`, `turn_context`,
  `world_state`, `event_msg`, …) are folded into `type`.
- Writer: per-line `write_all` + `flush()`, no fsync; multi-item commands
  stay independent lines and an I/O failure retains the unwritten suffix;
  newline termination enforced on append
  (`codex-rs/rollout/src/recorder.rs:1694-1723,1821-1875`).
- Adopt: one item per line with complete-prefix semantics; flat
  `type`+`payload` shape; `forked_from_id` concept (future fork);
  rebuildable derived SQLite. Reject: flush-as-durability; optional ordinal;
  filename-embedded timestamps for organization (we use the summary cache).

### OpenCode v2 — strongest precedent for the envelope and idempotency

- Structure: global XDG (`~/.local/share/opencode/`); one global SQLite
  (`opencode.db`, WAL) as the authoritative store; large tool outputs spill
  to `tool-output/tool_<ascending-id>` with a path marker in the message and
  a 7-day retention sweep; directory locks under XDG state
  (`packages/core/src/global.ts:10-15`,
  `packages/core/src/database/database.ts:43-55`,
  `packages/core/src/tool-output-store.ts:15-189`).
- Row: `event { id ("evt_" + ascending, PK), aggregate_id, seq (unique per
  aggregate, enforced in the transaction), created (epoch ms), type
  ("session.idle.1" — schema version as type suffix), data (JSON) }`
  (`packages/core/src/event/sql.ts:10-26`). The API envelope adds
  `location?`/`metadata?` that are not persisted.
- Idempotency: no separate receipt — the stored row is the receipt; replay
  dedups by `id` + payload deep-equality, divergence is a hard error
  (`packages/core/src/event.ts:263-292`). Durable admission commits
  `input.admitted` + a pending-inbox row in one transaction and wakes
  execution only after the commit.
- Adopt: the six-field envelope; stored-row-as-receipt idempotency (we
  implement it as `data.requestId` reconciliation); durable admission before
  wake; the durable/ephemeral split (deltas never persisted). Reject: global
  SQLite as canonical history (no two-phase commit across file + DB);
  expiring spill files as artifacts; ephemeral permission requests.

### Grok Build — directory-per-Session layout and commit-aware errors

- Structure: global `~/.grok/sessions/<encoded-cwd>/<uuidv7>/`, one directory
  per Session holding the authoritative `updates.jsonl`, derived
  `summary.json`, `chat_history.jsonl`, `plan.json`, `rewind_points.jsonl`,
  `compaction_checkpoints/`; global `session_search.sqlite` (FTS5, rebuilt);
  WAL disabled on network filesystems
  (`crates/codegen/xai-grok-pager/docs/user-guide/17-sessions.md:26-39`,
  `crates/codegen/xai-grok-shell/src/session/storage/search.rs:276`).
- Line: `SessionUpdateEnvelope { timestamp (unix seconds, debug only),
  method ("session/update" vs "_x.ai/…"), params }` — sessionId lives inside
  `params`; no id, no seq (only an occasional `_meta.eventId` counter), no
  version (`crates/codegen/xai-grok-shell/src/session/storage/mod.rs:596-607`).
- Writer strengths: a serializing persistence actor, a sidecar file lock,
  file + parent-directory sync in durable mode (`F_FULLFSYNC` on macOS), and
  the NotCommitted / Committed / AckLost error triage. Recovery weaknesses
  (counterexamples): newline-first torn-tail repair, skipping unparseable
  lines, persisted synthetic cancelled tool results.
- Adopt: directory-per-Session with co-located derived files (the direct
  precedent for our layout); the error-triage naming; parent-directory sync;
  UUIDv7 time-sortable IDs (kept as a future option). Reject: the lenient
  recovery trio and timestamp-as-ordinal.

### Claude Code — precedent for folding line kinds into `type`

- Structure: global `~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`,
  one file per Session, resume by directory scan, no index; global
  `history.jsonl`; image attachments in `image-cache/<sessionId>/`
  (`restored-src/src/utils/sessionStoragePortable.ts:325-331`,
  `restored-src/src/utils/imageStore.ts:9-35`).
- Line: every line carries a `type` discriminator covering both message
  kinds (`user`/`assistant`/`attachment`/`system`) and metadata kinds
  (`summary`/`custom-title`/`file-history-snapshot`/`queue-operation`, …).
  Message entries: `{ type, uuid, parentUuid, logicalParentUuid?,
  isSidechain, sessionId (stamped on every record), timestamp, cwd, userType,
  version (app version on every record), gitBranch?, message, toolUseResult?,
  … }` (`restored-src/src/types/logs.ts:221-231`,
  `restored-src/src/utils/sessionStorage.ts:1039-1064`). Ordering is a
  `parentUuid` linked list; schema evolution via optional fields and
  load-time bridging.
- Adopt: `sessionId` stamped per line; folding all line kinds into one
  `type` field (validates the reserved-key mechanism over a wrapper);
  `image-cache/<sessionId>/` as the artifact layout precedent. Reject:
  `parentUuid` chains as the ordering (no gap detection); per-line app
  version.

### Kimi Code — unverified (no source in the local reference repositories)

Claims from the research doc, pending verification against a pinned source:
`sessions/<workspaceId>/<sessionId>/{state.json, agents/<id>/wire.jsonl,
blobs/}`; several op lines coalesced into one buffer with one sync; a
file-level `metadata` protocol line; appending without truncating the torn
tail (a repair defect); dispatch publishing before the durability barrier (a
defect); content-addressed blobrefs published before the referring op (the
origin of artifact-before-fact); a four-phase compaction op lifecycle;
flush-before-fork with atomic child publication.

"Coalesced multi-line synced writes" and "artifact-before-fact" have entered
this direction, but their attribution should read as research-doc testimony
until a pinned Kimi source lands under `.references/`.
