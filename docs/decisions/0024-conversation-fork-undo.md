# 0024: Conversation Undo and Edit Fork a Session Without Reverting Files

## Status

Accepted on 2026-08-17.

## Context

Session history is a per-Session append-only fact log. Truncating it in place
would destroy the abandoned conversation branch and make the durable record
claim that observed messages and tool effects never happened. Reverting the
workspace is a separate and more dangerous operation: commands and tools may
have changed ignored files, nested repositories, processes, or external
systems that no local snapshot can restore honestly.

The removed shadow-git prototype confirmed that risk. A restore could delete
user files after `.gitignore` changed, had no redo baseline, could be bricked
by a stale index lock, and could not see nested repositories. Its operational
surface was disproportionate to conversation undo.

Codex's current `thread/fork` API supplies an exclusive `beforeTurnId`
boundary, truncates persisted rollout history at that boundary, derives the
new thread with the source cwd and configuration, gives it a fresh identity,
and records the source thread. Its older same-thread `thread/rollback` API is
deprecated. Kimi Code independently exposes conversation undo with explicit
copy that code changes are not rolled back, and exposes historical Session
forking as a separate operation.

## Decision

Undoing to or editing an earlier user message creates a new Session. The
source Session stays untouched. The target starts with a new
`session.created` fact that records its immediate `parentSessionId`, the source
input boundary, and whether the fork was for `undo` or `edit`; it inherits the
source Session's working directory, Mate binding, title, and metadata.

The EventStore creates the target Session and its source-history reference in
one operation serialized with source appends. The target's `session.created`
fact records both logical provenance (`parentSessionId`,
`forkedFromInputId`, and `forkReason`) and a physical `historyBase` position:
the contributing journal's Session ID, exclusive sequence, and exclusive byte
offset. The target journal does not copy the inherited prefix. Readers resolve
immutable byte-bounded history segments from headers, close ancestor handles
after each read, rewrite inherited envelopes to the target `sessionId`, and
then apply target-local facts. They do not recursively load or cache ancestor
Session projections.

The effective history starts after the contributing root's `session.created`
fact and ends before the selected `input.admitted` fact. Envelope IDs,
sequence numbers, versions, and timestamps remain stable, which keeps
compaction checkpoints and domain-ID references valid. A fork is first written
and synchronized in a staging directory; only a directory rename followed by
parent-directory synchronization publishes it. Recovery removes unpublished
staging directories. Ordinary append may create a root Session, but cannot
write any fork metadata or history reference. Copied-prefix fork journals are
not a supported compatibility format.

The boundary input may have been admitted while an earlier Turn was running,
which puts the cut between `turn.started` and its terminal fact. A target
left with a permanently Started Turn would never run again, so the store
closes each Turn opened but not terminated inside the prefix with a synthetic
`turn.interrupted` fact — the same shape Codex appends when a fork snapshot
ends mid-turn.

Pure undo stops after creating the fork. Edit admits the replacement user
input into the target and schedules it normally. Its `parentInputId` may point
to the omitted source input only when it equals the target Session's recorded
fork boundary; other parent references remain same-Session references.

Inputs queued before the fork boundary but cancelled after it are inherited
by the target as pending and would rerun discarded work on the next wake. Their
`conversation_fork` cancellation facts are included in the target's staged
journal before publication. The server owns source cancellation, fork,
replacement admission, and wake ordering; the GUI sends one fork request.

Files, processes, command effects, and external state are never rolled back.
Every model context assembled for a forked Session includes one user-role
divergence notice before ordinary turn history. The notice says only that the
abandoned branch's effects may remain. The GUI never implies workspace
restoration.

Undo and edit are implementation-level forks, not user-visible conversation
creation. Every continuation keeps the root `conversationId`. Session listing
selects the latest physical continuation per conversation before pagination,
and deleting that visible conversation removes its full reference chain. The
GUI replaces the current conversation with the fork projection in one state
transition and does not expose fork provenance in the conversation header.

The fork response contains the history sequence cursor and only target-local
facts. The GUI joins that bounded response to the already displayed immutable
prefix, then resumes SSE after the resulting tail. Event replay is paged by
sequence cursor so the server does not assemble an unbounded HTTP response.

## Consequences

- Undo is lossless in durable storage. The GUI presents the latest continuation
  as the same conversation instead of exposing both backend Sessions.
- Forked histories intentionally share ancestor event and domain ids, scoped
  by their Session ids.
- Physical deletion rejects referenced ancestors. User-visible conversation
  deletion acquires the lineage and removes it child-first as one operation.
- Physical fork journals stay proportional to their local delta instead of
  accumulating a complete copy at every undo or edit. Deep lineage resolution
  retains only the selected Session projection and closes every ancestor file.
- A fork can show old conversation facts beside a newer live workspace. The
  durable provenance and repeated model notice make that divergence explicit.
- The JSONL store needs a first-class fork operation; ordinary append cannot
  create and validate the history reference at the source boundary.
- Per-file copy checkpoints remain possible future work, but would be a
  distinct file-restore feature rather than conversation undo.
