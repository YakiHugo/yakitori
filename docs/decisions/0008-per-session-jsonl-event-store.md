# 0008: Use One JSONL Commit Journal per Execution Session

## Status

Accepted and implemented on 2026-07-27. Decision 0009 supersedes this
decision's commit-record format, batch recovery boundary, and generic
operation receipts. The per-Session layout, runtime lock, per-Session I/O gate,
durability ordering, summary cache, and store ownership remain in force. This
decision still supersedes decision 0005 and the SQLite projection container in
decision 0007.

## Context

Decision 0005 selected SQLite before the runtime topology was fixed. It
therefore optimized for independent processes concurrently appending to one
Session. The implemented product now has two stronger ownership boundaries:

- one runtime lock excludes a second Yakitori server from the same store; and
- one Session kernel queue permits at most one command to mutate a Session at
  a time.

Different Mates still execute concurrently, but each Assignment uses a
different Session. Cross-process writes to one Session are not a supported
topology. Keeping SQLite's `BEGIN IMMEDIATE`, WAL, projection table, and
cross-connection CAS for that topology adds a database-shaped source of
complexity without serving the execution model.

Codex provides the closer model: a Thread rollout is an inspectable JSONL
record, one live writer owns it, and query-oriented state may be rebuilt.
Grok Build provides a useful durability cross-check: serialize work through a
Session owner, treat a complete line as the recovery boundary, and do not rely
on SQLite WAL behavior on arbitrary filesystems.

## Decision

### Canonical layout

Each execution Session owns a directory:

```text
.yakitori/sessions/<sessionId>/
|- events.jsonl
`- summary.json
```

`events.jsonl` is canonical. `summary.json` is a disposable listing cache and
may be deleted, corrupt, or stale without losing a recorded fact.

SQLite remains appropriate for Mate identity and for future relational
Room/Task/Assignment/Message/Delivery queries. The default Mate database is
`.yakitori/mates.sqlite`; Session events no longer share it.

### Commit record and durability

One JSONL line is one logical append commit, not one event. The versioned
record contains the Session ID, first sequence, a non-empty event batch, and
the optional operation ID and request fingerprint. This makes the fact batch
and its idempotency receipt one indivisible recovery unit.

The writer:

1. validates expected sequence and computes the candidate projection in
   memory;
2. appends the complete serialized record plus its newline;
3. synchronizes the journal file; and only then
4. publishes the new in-memory events, receipt, and projection to callers.

The newline is the commit marker. During lazy Session initialization, bytes
after the final newline are an uncommitted torn tail and are truncated under
the Session I/O gate. A malformed newline-terminated record is committed
corruption: startup fails with `InvalidEventLog` and does not silently discard
it.

If write or sync reports an error, the writer closes and reopens the journal,
reconciles to the last committed newline, and checks the operation receipt. An
operation whose complete record is present returns its original events only
after the reopened handle synchronizes successfully. A non-idempotent
ambiguous append reports the error rather than guessing.

### Ownership and serialization

The runtime lock in the canonical Session store directory is the cross-process
exclusion boundary. Inside that process, one per-Session I/O gate covers lazy
initialization, tail repair, reads, appends, and explicit rebuilds. The gate is
broader than the kernel command queue so maintenance and read APIs cannot race
journal initialization.

The store keeps one append-capable file handle and current projection for each
loaded Session. `close()` rejects new work, drains admitted store operations,
Session gates, and summary workers, synchronizes any recovery state whose
durability remains uncertain, and closes every handle before the runtime lock
is released.

### Derived reads

The in-memory Session projection is advanced only after the journal is durable.
`rebuildProjection` rereads the canonical journal and replaces the cached
projection. Unknown event types remain opaque facts and still advance the
Session sequence, including when their commit carries an operation receipt. An
older runtime may reject an exact retry it cannot represent, but it does not
reject the Session while loading history.

`summary.json` records its format version and the exact journal byte length it
summarizes. Session listing trusts it only when that length matches the current
journal. Missing, invalid, or stale summaries are rebuilt from `events.jsonl`.
Summary updates are atomic rename-based, best effort, coalesced per Session,
and drained on close; their failure never turns a durable journal append into
a failed operation.

The HTTP server no longer creates an implicit persistent store. A caller must
inject handlers, a kernel, or an event store, while
`createYakitoriApplication()` remains the composition root that acquires the
runtime lock and owns storage shutdown.

## Existing SQLite Data

There is no automatic Session importer from the pre-release `events.sqlite`
schema. Changing the default makes local development Sessions from decision
0005 invisible, but it does not delete that database. When `mates.sqlite` does
not yet exist, the application continues using an existing `events.sqlite` as
the Mate database so stable Mate identities, profiles, and revisions remain
visible. New installations and explicit paths use `mates.sqlite`.

If retained Session history becomes a requirement, add an explicit,
versioned, one-way importer; startup must not guess which Session store is
authoritative.

## Consequences

- A Session is a portable, append-only, line-inspectable artifact.
- Event batches and operation receipts retain one durable commit boundary.
- Supported concurrency matches the domain: parallel Sessions, one writer per
  Session, and one server per store root.
- Recovery behavior is explicit for a torn final record and strict for
  committed interior corruption.
- Session listing has a rebuildable cache instead of a second authoritative
  projection table.
- Relational collaboration data can still use SQLite without coupling the
  execution transcript to that database.
- Running two EventStore instances against the same Session directory is a
  protocol violation; the runtime lock, not filesystem advisory locking,
  prevents it in the application.
