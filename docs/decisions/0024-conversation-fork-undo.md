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

The EventStore materializes the target Session and the source event prefix in
one operation serialized with source appends. The prefix starts after the
source `session.created` fact and ends before the selected `input.admitted`
fact. Copied envelopes preserve ids, sequence numbers, versions, and
timestamps, rewriting only `sessionId`. Preserving sequence numbers keeps
compaction checkpoints and all domain-id references valid. A failed operation
must not expose a partial target Session.

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
by the target as pending and would rerun discarded work on the next wake. The
fork route cancels every inherited pending input (`conversation_fork`) before
admitting a replacement or waking the target.

Files, processes, command effects, and external state are never rolled back.
Every model context assembled for a forked Session includes a user-role
divergence notice before ordinary turn history. The notice says the abandoned
branch's effects may remain and directs the model to inspect current state and
re-read files before editing. The GUI uses the same language and never implies
workspace restoration.

Forking is rejected while the source has an active Turn or queued Inputs. The
caller must explicitly cancel active work first; fork does not introduce an
implicit cancellation policy.

## Consequences

- Undo is lossless at the conversation layer: both branches remain readable.
- Forked histories intentionally share ancestor event and domain ids, scoped
  by their Session ids.
- A fork can show old conversation facts beside a newer live workspace. The
  durable provenance and repeated model notice make that divergence explicit.
- The JSONL store needs a first-class fork operation; ordinary append cannot
  preserve envelopes or provide the required all-or-nothing target creation.
- Per-file copy checkpoints remain possible future work, but would be a
  distinct file-restore feature rather than conversation undo.
