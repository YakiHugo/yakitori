# 0009: Store One Session Fact per Journal Line

## Status

Accepted on 2026-07-30. This decision supersedes the commit-record format,
batch recovery boundary, and generic operation receipts in decision 0008. It
also supersedes decision 0007's requirement that input admission use a generic
operation receipt. Decision 0008's per-Session layout, runtime lock,
per-Session I/O gate, durability ordering, summary cache, and store ownership
remain in force. Decision 0007's witness semantics remain in force.
Decision 0024 later qualifies physical sequence contiguity for referenced fork
journals: their effective history remains gap-free, while their local file may
contain `session.created` followed by facts whose sequences continue after an
inherited prefix.

## Context

Decision 0008 made one versioned `{ record: "commit", events: [...] }` JSONL
line the atomic unit of Session persistence. That was a useful step away from
SQLite, but it makes a kernel command batch the smallest stable history unit.
Future fork boundaries, compaction suffixes, incremental indexing, and
per-fact schema migration need a durable coordinate for each fact.

The current event envelope already contains that coordinate: a stable event
ID, owning Session ID, gap-free Session sequence, schema version, timestamp,
type, and payload. Wrapping those envelopes in a second batch record adds no
fact-level information.

A command may still produce several facts and the writer may still admit them
with one write and one synchronization. Physical I/O batching does not require
logical batch atomicity. If a crash leaves only a complete prefix of those
facts, that prefix is honest history: an open Turn or Tool means only that no
terminal fact was durably observed. Fabricating or discarding facts to make a
command look atomic would conflict with the kernel-as-witness rule.

The generic operation receipt in decision 0008 exists only for durable input
admission today. It duplicates domain data already present in
`input.admitted.data.requestId`. A stored admission fact can itself be the
receipt when the store maintains a derived request index and compares the
retry payload.

## Decision

### One flat fact envelope per line

Each new `events.jsonl` line is the JSON serialization of exactly one existing
stored event envelope followed by `\n`:

```json
{"id":"event_…","sessionId":"session_…","seq":41,"version":1,"createdAt":"…","type":"tool.result","data":{…}}
```

The permitted top-level keys are exactly:

- `id`
- `sessionId`
- `seq`
- `version`
- `createdAt`
- `type`
- `data`

There is no framing wrapper, batch ID, item count, operation field, checksum,
or commit marker. Event-specific validation remains the responsibility of the
existing envelope and projection boundaries. Unknown event types remain
opaque stored facts and advance `seq` normally.

The top-level key `record` is reserved for framing. A line whose parsed object
contains `record` is always routed to the legacy record validator. It must be a
valid decision-0008 commit record; a malformed or unknown record kind is
committed corruption and must not fall back to fact parsing. A fact line must
not contain `record` or any other extra top-level key.

### Write and publication protocol

For one `appendEvents` call, the writer:

1. checks the caller's expected sequence against the loaded Session tail;
2. assigns consecutive sequences and creates the candidate envelopes;
3. applies the candidate facts to a temporary projection to validate them;
4. serializes every envelope independently with a trailing newline;
5. joins those serialized lines into one buffer;
6. writes the complete buffer with `writeAll` and synchronizes the file; and
7. only after synchronization advances the in-memory event list, admission
   index, projection, and observable result.

One buffer and one sync preserve efficient I/O. They do not create a logical
transaction across its lines. The newline terminates each durable fact.

### Complete-prefix recovery

Recovery retains every complete, newline-terminated fact in file order. Only
bytes after the final newline are an uncommitted torn tail. Before any later
append, the store truncates that tail and synchronizes the repaired file.

This explicitly abandons the decision-0008 zero-or-all batch recovery
contract. A multi-fact command may leave any complete fact prefix after a
crash. The recovered projection is the projection of exactly that prefix. In
particular, a Turn with an opening fact but no terminal fact remains open;
recovery never invents closure facts.

Within the complete prefix, all lines are committed. Invalid JSON, an invalid
envelope or legacy record, a Session mismatch, a duplicate sequence, or a
sequence gap is corruption and fails with `InvalidEventLog`. No complete line
is silently skipped.

For a decision-0024 referenced fork, this validation applies separately to
each referenced physical segment and the target-local suffix, then to the
materialized effective history. A sequence jump between the target header and
its first local fact represents the referenced prefix rather than corruption.

### Legacy read compatibility

Readers accept both formats:

- a fact line contributes one envelope; and
- a valid decision-0008 commit line expands to its non-empty `events` array.

One shared `expectedSeq` counter validates every expanded envelope, so legacy,
fact, and mixed journals have the same gap-free ordering rule. Legacy
`operation` receipts are accepted and validated as part of the old format but
are read-only compatibility data; new writes never emit them.

There is no automatic rewrite. A one-way repair or migration tool is deferred
until fork or explicit migration tooling has a real caller.

### Admission reconciliation replaces operation receipts

`EventStoreAppendOptions.operation` is removed. The store instead exposes the
minimal request reconciliation option required by `admitInput`: the stable
`requestId` and the fingerprint of the admission payload.

While replaying a Session, the store indexes every `input.admitted` fact by
`data.requestId` together with its payload fingerprint and recorded envelope.
It maintains the same disposable index after successful appends. A duplicate
request ID in the journal is corruption, even when the payloads match, because
a correct writer records one admission fact for one request.

Before appending an admission:

- same request ID and same payload fingerprint returns the recorded fact;
- same request ID and different payload fingerprint reports ID reuse; and
- an unseen request ID proceeds through normal expected-sequence validation.

This makes the domain fact the idempotency receipt. It does not introduce a
generic store-level operation protocol for commands that have no concrete
idempotency requirement.

### Ambiguous append outcomes

If write or sync reports an error, the store discards its loaded handle,
reopens the journal, repairs any torn tail, rebuilds the complete prefix, and
synchronizes any recovered bytes whose durability is uncertain. It then
classifies the attempted append:

- **NotCommitted:** none of the attempted facts is present; propagate the
  original error.
- **Committed:** the complete attempted fact sequence is present; return the
  recorded envelopes.
- **AckLost:** for input admission, the request ID and fingerprint reconcile
  to the recorded admission fact even though the original write call failed;
  return that recorded fact.

A partial multi-fact prefix is retained but is not reported as full success.
Callers must observe the recovered Session and decide what honest follow-up is
appropriate. The store never retries the write blindly.

## Consequences

- Physical journal line count equals durable fact count for newly written
  journals.
- Every fact has a stable line and sequence boundary suitable for later exact
  forks, suffix indexing, and compaction.
- Recovery preserves more truthful information than batch rollback: every
  complete prefix survives, including incomplete workflows.
- Multi-fact append calls no longer promise zero-or-all crash recovery.
- Input admission remains retry-safe without duplicating request identity in a
  generic receipt envelope.
- Existing decision-0008 journals remain readable and may be extended with
  fact lines, but new writers never emit legacy commit records.
- `summary.json`, the runtime lock, the per-Session gate, and the one-sync
  append protocol are unchanged.

## Deferred Work

This decision does not add artifact storage, a SQLite sequence/offset index,
compaction facts, exact-boundary fork, taxonomy changes, legacy rewrite tools,
or a generic multi-fact saga. Those capabilities require their own trigger and
review.
