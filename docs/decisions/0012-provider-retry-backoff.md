# 0012: Retry Transient Provider Errors with Bounded Backoff

## Status

Accepted on 2026-07-31. Amended on 2026-07-31: corrected the worst-case
backoff figure, and recorded that SDK-internal retries are disabled and
mid-stream failures are classified by transient error type/code.

## Context

Any provider failure — a rate limit, an overloaded gateway, a dropped
connection — ended the Turn with `turn.failed`. Mature coding agents
universally retry transient failures with exponential backoff and jitter
(Claude Code, Codex, and both vendor SDKs' own guidance converge on this);
only client errors (4xx such as 400/401/403) are terminal by consensus.

The provider boundary yields errors as terminal stream responses shaped
`{ code, message }`, discarding the HTTP status, so no caller could
distinguish "try again" from "give up".

## Decision

### Providers classify; a generic wrapper retries

- Each real provider maps caught SDK errors into the existing
  `ModelError.details` envelope: transient failures carry
  `details: { retryable: true, status?: number }`. Retryable means the
  consensus set — HTTP 408, 409, 429, 500, 502, 503, 504, 529 — plus the
  SDKs' connection/timeout error classes (no status). Mid-stream failures
  carry no HTTP status (the Anthropic SDK throws an `APIError` with an
  undefined `status` for SSE `error` events; OpenAI stream `error` events and
  `response.failed` carry only a code), so classification also maps a small
  transient set — Anthropic error types `overloaded_error` and `api_error`,
  OpenAI codes `server_error` and `rate_limit_exceeded` — to
  `retryable: true`. Non-transient errors keep the exact previous shape;
  `code`/`message` are unchanged, so no existing consumer is affected.
- `withRetries(stream, options?)` wraps any `StreamFn`: on a terminal
  error response flagged retryable, it waits and starts a fresh attempt with
  the same request. Defaults: 4 total attempts, 500 ms base doubling per
  attempt, full jitter, 8 s cap. Sleep and randomness are injectable for
  tests; abort is honored before and during the wait and yields the standard
  aborted terminal response.
- Streaming snapshots pass through per attempt and are never persisted, so a
  retry simply restarts the ephemeral preview. Retries record no durable
  facts — nothing durable happened until a response lands.
- Only the Anthropic and OpenAI providers are wrapped at composition. The
  faux provider stays deterministic for scripted development and tests.
- Both SDKs default to two internal retries, which would stack under the
  wrapper (up to 12 HTTP attempts per model call). Default client
  construction passes `maxRetries: 0`, so the wrapper is the only retry
  layer.

## Rejected Alternatives

- **Retrying inside each provider.** Duplicates the policy per SDK and makes
  the faux provider's determinism harder to see; one boundary wrapper keeps
  the policy in exactly one place.
- **Unbounded or long-window retry queues.** A bounded 4-attempt policy keeps
  failure latency honest; if every attempt fails the Turn fails as before,
  with the same recorded error shape.
- **Retrying 4xx.** Client errors (auth, bad request) do not heal with time;
  retrying them only delays the honest failure.

## Consequences

- Rate limits and transient network faults no longer kill Turns; hard
  failures keep their existing recorded shape and timing bounds (worst case
  adds ~3.5 s of backoff before failing: three sleeps of at most 500, 1000,
  and 2000 ms at full jitter).
- The retry policy is a runtime concern only: no API, journal, or envelope
  changes.
