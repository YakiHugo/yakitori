# Stage: Per-Fact Journal Lines

> Archived 2026-07-30: this stage is complete. This document is a historical
> record — do not implement from it. Decision 0009 and
> `docs/kernel-persistence-direction.md` are authoritative.

Status: completed and archived
Depends on: kernel persistence direction (`docs/kernel-persistence-direction.md`)

This stage switches the Session journal from one `{ record: "commit",
events: [...] }` batch per line to one fact per line, with complete-prefix
recovery. Everything else in the persistence direction (artifacts, the SQLite
index, compaction, fork, taxonomy) is explicitly out of scope.

## Why now

The format is the precondition for every deferred capability: exact-boundary
fork, per-fact schema migration, compaction checkpoints with suffixes, and
incremental indexing all require a stable per-fact durable unit. The change is
small because the existing envelope already satisfies the fact shape (see the
field-by-field verification in direction principle 3) and the write path
already performs one `writeAll` plus one sync per append.

## Decisions Applied

- Zero added envelope fields: a fact line is the flat serialization of the
  existing event envelope — no `record`/`formatVersion` wrapper, no
  `operation` receipt field (direction principles 3 and 6).
- Idempotency moves to domain reconciliation: `admitInput` reconciles
  `input.admitted` facts by `data.requestId` plus a payload fingerprint
  (OpenCode-style "the stored row is the receipt"). The store rebuilds the
  admission index while reading the journal; a duplicate `requestId` in the
  journal is corruption.
- Legacy `{ record: "commit", ... }` lines remain readable: `record` acts as
  a framing-level reserved key that routes to the legacy validator, which
  expands the line into its constituent facts; the writer emits only fact
  lines. A one-way rewrite tool is deferred until fork or migration tooling
  has a real caller.
- The 13 existing event types are unchanged. Every multi-event append today
  (`assistant.message` + `tool.call`*, `assistant.message` + a terminal Turn
  fact) forms valid honest prefixes, so no command depends on batch
  atomicity.
- Tool results stay coarse (direction principle 7): this stage does not touch
  the `tool.result` shape, nor the current behavior of recording a
  tool.result with a truthful `error.code` on permission denial — it is
  honest (the message states "No process was started") and, jointly with the
  standalone permission facts, fully reconstructible.
- `expectedSeq` stays as an internal assertion between the kernel's cached
  projection and the store tail; the single-writer gate remains the
  sequencing authority.
- `summary.json`, the runtime lock, and the per-Session I/O gate are
  untouched.

## Work Items

### 1. Decision records and documentation

- Add `docs/decisions/0009-per-fact-journal-lines.md`: accepts complete-prefix
  fact-line recovery and abandons the batch zero-or-all contract; defines the
  fact line format (the plain flat envelope serialization of direction
  principle 3) and the `record` reserved-key rule; restates write semantics
  (assign seqs, reducer-validate, serialize per line, join one buffer,
  `writeAll`, one sync, advance projections and publish only after sync) and
  recovery rules (complete-prefix retention, truncate-and-sync the torn tail
  before appends, committed corruption fails loudly, unknown types opaque,
  NotCommitted / Committed / AckLost triage); records the two decisions to
  move idempotency to domain reconciliation and to keep legacy read
  compatibility.
- Amend the Status section of
  `docs/decisions/0008-per-session-jsonl-event-store.md`: the record format
  is superseded by 0009; the journal layout, lock, gate, and summary
  decisions remain in force.
- Update the persistence paragraphs of `docs/architecture.md` and the
  append-oriented persistence bullet in `AGENTS.md` to per-fact wording.
- The research document is archived at
  `docs/archive/session-storage-strategy-research.md` (done 2026-07-30, ahead
  of this stage; its banner names this direction document and decision 0008 as
  authoritative until 0009 lands).

### 2. Journal format (`src/kernel/jsonl-event-store-format.ts`)

- Add `serializeFactLine(envelope)` (plain flat envelope serialization, no
  wrapper).
- Add `parseJournalLine(line, recordNumber)`: a line containing the reserved
  `record` key goes to the legacy `commit` validator (`parseCommitRecord`
  stays for reads only); anything else goes to the fact validator (strict
  whitelist + `parseStoredEventEnvelope`).
- Summary cache helpers unchanged.

### 3. Store (`src/kernel/jsonl-event-store.ts`)

- Write path: remove the `operation` receipt machinery; serialize each
  envelope as its own line, join one buffer, one `writeAll` + one sync; the
  post-sync in-memory advancement and the ambiguous-error reconciliation path
  are unchanged (AckLost reconciliation now uses the admission index and fact
  IDs).
- Admission index: replace `LoadedSession.operations` with an index of
  `input.admitted` facts by `data.requestId` (including payload
  fingerprints); rebuilt while reading the journal, updated after successful
  appends; a duplicate `requestId` is corruption.
- Read path: torn-tail truncate + sync unchanged; parse line by line via
  `parseJournalLine` — fact lines directly, legacy commit lines expanded —
  sharing one `expectedSeq` counter so mixed journals stay contiguous.
- `EventStore` interface: remove `operation` from `EventStoreAppendOptions`
  in favor of the minimal option needed for admission reconciliation
  (requestId reconciliation); update doc comments for complete-prefix
  semantics. Keep signature churn minimal.

### 4. Kernel (`src/kernel/session-kernel.ts`)

- `admitInput` idempotency moves from the `operation` receipt to requestId
  reconciliation: same requestId + same payload returns the recorded fact;
  same requestId + different payload is an error. No other command changes.

### 5. Tests (`test/kernel/`, plus any runtime tests asserting journal shape)

- One physical line per fact; fact lines carry no `record`/`operation` fields
  (format snapshot).
- Byte-cut: replaying the journal truncated at every newline boundary yields
  exactly the projection of that fact prefix.
- A simulated crash landing only part of a multi-fact buffer keeps the
  complete prefix; an unterminated Turn stays open with no fabricated
  closure.
- Admission idempotency: same requestId + same payload (including across
  restarts / AckLost scenarios) returns the recorded fact; same requestId +
  different payload errors; a duplicate requestId in the journal is detected
  as corruption.
- Legacy fixtures: a commit-record journal (with a receipt) reads back its
  facts and admission index; appends after a legacy prefix continue `seq`
  contiguously; mixed-format replay equals full replay.
- Existing torn-tail, malformed-committed-line (both formats), unknown-type
  opacity, and seq gap/duplicate cases updated to the new format.

### 6. Verification

- `pnpm check` green (typecheck, lint, tests).
- Size budget: format + store + tests + docs under roughly 800 lines. If
  legacy read compatibility pushes it over, split it into its own follow-up
  change.

## Non-Goals

Artifact storage, the SQLite seq/offset index, compaction facts, fork, fact
taxonomy changes (including a fine terminal-Tool-outcome taxonomy — rejected
in the direction document), legacy one-way rewrite tooling, and any changes
to `summary.json`, the runtime lock, the I/O gate, or the server/runtime
boundaries.
