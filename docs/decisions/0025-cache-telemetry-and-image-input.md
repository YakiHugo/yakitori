# 0025: Observe Provider Caching and Admit Image Input

## Status

Accepted on 2026-08-19. Amends decision 0018.

## Context

Session usage recorded only successful Turn totals. A provider could therefore
bill one or more calls before a Turn failed while Yakitori displayed zero. The
runtime also discarded provider-reported cache reads and writes, so high input
usage could not be separated into cached and uncached tokens.

Conversation forks inserted a local fork notice before inherited history. That
changed the prompt near its beginning and prevented the shared history from
remaining a byte-stable cache prefix. Kimi's coding endpoint supports the
Anthropic-compatible explicit cache controls used by its first-party harness,
but Yakitori enabled them only for official Anthropic requests.

The GUI accepted text only, even though both configured provider protocols
support image input.

## Decision

Runtime records provider-reported input, output, cache-read, and cache-write
tokens on every terminal Turn, including failed, cancelled, and interrupted
Turns. It also records model-call count and wall time, tool-call count and wall
time, and average time to the first stream event. The GUI derives its session
telemetry rail exclusively from these durable terminal facts. Cache hit rate is
cache-read input tokens divided by total input tokens; it is unknown when the
provider supplies no input usage.

OpenAI requests use the durable conversation ID as `prompt_cache_key`.
Anthropic and Kimi requests use it as the cache-routing user ID and receive
explicit ephemeral breakpoints. Forks retain the same conversation ID and
place the fork notice after inherited Turn history, keeping the shared prefix
stable. These are provider-side prompt caches; Yakitori does not maintain a
second local response cache.

User text content may include up to four PNG, JPEG, GIF, or WebP attachments,
with a four-megabyte per-image and ten-megabyte aggregate decoded-size limit.
The event log stores the validated base64 payload so replay and forks remain
self-contained. Provider adapters translate the attachment into their native
image blocks. The composer supports file selection, paste, and drag-and-drop.

## Consequences

- Failed provider work is visible instead of disappearing from session usage.
- Cache percentages reflect provider accounting rather than a client-side
  estimate.
- Shared fork history and repeated calls have stable cache-routing identity and
  prompt prefixes.
- Session journals can grow by the size of admitted images; limits bound each
  admission and HTTP bodies allow the encoded payload.
- Existing text-only event and provider message shapes remain valid.
