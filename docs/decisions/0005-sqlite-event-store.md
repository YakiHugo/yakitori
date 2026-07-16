# 0005: Replace JSONL with Transactional SQLite Event Storage

## Status

Accepted and implemented.

This decision supersedes only the JSONL storage choice in decisions 0002 and
0003. Their kernel and server boundaries remain active.

## Context

The first kernel used one JSONL event log per Session. That made persistence
easy to inspect, but the server now needs stronger write semantics before an
agent runtime introduces retries and concurrent writers:

- input admission must be safely retryable after an ambiguous HTTP result;
- appends must reject stale projections instead of silently writing an invalid
  transition;
- the event batch and its idempotency receipt must commit atomically; and
- independent local server processes must coordinate through durable storage.

Implementing those guarantees with lock files and several coordinated JSONL
files would create a second storage protocol. The project is still early enough
to replace its development storage without preserving that complexity.

## Decision

Use one local SQLite database as the default event store. Keep the
storage-neutral `EventStore` interface so the kernel does not depend on SQLite.

The database stores:

- append-only event envelopes keyed by `(session_id, seq)`; and
- operation receipts keyed by `(session_id, operation_id)` with a request
  fingerprint and the range of events produced by the operation.

Each append transaction uses `BEGIN IMMEDIATE`, reads the current Session
sequence, checks an optional expected sequence, inserts a gap-free event batch,
and records its operation receipt before commit. SQLite runs in WAL mode with
full synchronous durability and a bounded busy timeout.

An exact operation retry returns its original recorded events even if later
events have already advanced the Session. Reusing an operation ID with a
different fingerprint is an invalid state. Stored envelopes are validated on
normal reads and receipt replay so corrupted identity or sequence data does not
silently enter a projection.

Clients must retain the operation request ID across ambiguous transport results
and clear it only after a successful response. The GUI keeps this small outbox
in browser-local storage so changing Sessions or reloading does not turn a retry
into a second admission.

The implementation supports the repository's Node 24 floor. SQLite defensive
mode is enabled when the running Node version exposes it; schema and query text
remain internal either way.

## Existing JSONL Data

The SQLite store does not automatically import `.yakitori/sessions/*/events.jsonl`.
Changing the default store can therefore make old local development Sessions
invisible, but it does not delete or rewrite those files.

This is accepted for the current pre-release learning project. If preserving
JSONL history becomes necessary, add an explicit, versioned, one-way importer
that validates every envelope before committing it. Do not make runtime startup
guess whether or how to migrate old files.

## Consequences

- Compare-and-append and idempotency receipts now share one atomic commit.
- Multiple local connections coordinate through SQLite rather than process-only
  locks.
- Event payloads remain explicit JSON envelopes, preserving replay and
  debugging boundaries even though the container format is binary.
- Session listing still rebuilds summaries from events. A future projection
  index should be explicit and disposable rather than becoming a second source
  of truth.
- Database schema migrations and large payload storage remain deferred until a
  real caller requires them.
