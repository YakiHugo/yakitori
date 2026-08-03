# Code Follow-Ups

Status: living register of recorded code work. Each item lands as its own
small reviewable change or is absorbed into a redesign stage. Recorded from
the 2026-07-30 documentation/code audit; nothing here is started.

## Mate redesign (recorded direction)

All Mate-related code (`src/mates/`, plus the Mate-facing parts of the runner
and server) will be redesigned. Until that redesign lands, avoid growing the
current Mate implementation beyond what the coding-agent stage needs.

Open questions the redesign should answer explicitly:

- Whether the Mate projector stays a strict validator (a "judge": first event
  must be `mate.created`, gap-free sequence, monotonic revisions, no revising
  inactive Mates) while the Session kernel is a witness (decision 0007). The
  divergence is currently undocumented.
- Whether the Mate store keeps the `events.sqlite` fallback introduced by
  decision 0008 ("Existing SQLite Data").

## Dead code deletion candidates

Each can land first as an independent small change:

- `src/actors.ts` and its re-export in `src/index.ts` — no internal caller;
  reintroduce with the collaboration stage that needs it.
- `createToolCallId` in `src/kernel/ids.ts` — never called; tool call IDs
  come from the model response.
- `ItemProjection.metadata` in `src/kernel/session-projector.ts` — declared
  but never assigned.
- `ModelRequest.metadata` / `ModelResponse.metadata` in
  `src/runtime/model.ts` — only the faux provider plumbs them.
- `approvalPolicy` in `TurnExecutionContext` — recorded on `turn.started` but
  never consumed; actual approval behavior is driven by
  `RuntimeTool.autoAllow`. Removing it changes the `turn.started` fact shape
  and requires an explicit envelope-version decision.

## Stale wording in code

- `src/server/handlers.ts` error messages say "in Stage 1" while stage 1 is
  archived (`docs/archive/`). Reword to describe the restriction without
  naming a stage (for example, "in the current single-Mate stage").

## Desktop shell follow-ups (recorded 2026-07-31)

- Packaged builds launched from Finder resolve the default workspace/store
  from `process.cwd()` (which is `/`). Before shipping packaged builds, add a
  workspace picker or a user-data default with an explicit project-open flow
  (decision 0010, Deferred Work).
- Static GUI serving is GET-only (no HEAD); add HEAD if a real client needs
  it.
- `pnpm package:desktop` produces an unsigned `dir` build only; signed
  `dmg`, notarization, and auto-update are unconfigured.
- `dev:desktop` shares port 4141 with `dev:server`; running both at once
  collides on the runtime lock and the port.

## Coding-tool protocol status (recorded 2026-08-03)

These items came from comparing the current file tools with the pinned Codex,
OpenCode, Grok, and Claude Code references, an installed Claude Code 2.1.150
binary, and the official Claude Code changelog through 2.1.220. They are
a record of what has landed and what remains deferred, without expanding the
kernel fact protocol ahead of a concrete consumer.

### Read delivery and compaction correctness — implemented

- Separate durable file revision evidence from model-context delivery state.
  `FileObservationStore` may rebuild the latest observed SHA and continuation
  preconditions from successful recorded tool results, but a historical read
  fact must not prove that its text is still visible after compaction.
- Remove the Session-wide `reads` set and `read_file`'s durable
  `read_unchanged` result. Every successful read records its own bounded,
  self-contained result. Deduplicate only in `buildModelContext`: among
  selected results with the same path, SHA, requested range, and rendering
  limits, render one real result and replace the other model-visible copies
  with short references to it. This also lets duplicate reads from one model
  response show the model one body without making a later tool result depend
  on an in-memory cache.
- Apply result deduplication before context byte/block accounting and select a
  real representative from the results that remain in the assembled context.
  Compaction, truncation, and resume then recompute the representative from
  durable self-contained facts; no persisted stub can outlive the content it
  references. If only one result remains, it renders normally.
- Keep any visible-observation gate separate from durable revision evidence.
  The former is derived from final, untruncated tool results in the exact
  context used for the model call; results truncated again by context assembly
  conservatively grant no observation. The latter may be rebuilt from the
  complete journal for SHA and continuation checks. Do not include historical
  read-delivery identities in a hot-path file revision checkpoint.

### Grep pagination — implemented

- Until a real search-snapshot consumer exists, align with the reference
  agents' live-search semantics: `offset`/`head_limit` pagination may rerun
  ripgrep against the current workspace and is explicitly best effort. Remove
  the `expected_revision`/`snapshot_token` contract rather than presenting the
  Session observation checkpoint as a workspace snapshot.
- Preserve grep's existing cross-tool behavior: only visible returned matches
  may produce bounded path/range observations, and their full-file SHA must be
  verified before the observation can supply a later edit precondition. A grep
  range does not authorize `write_file`, which requires a complete observation.
  Removing the pagination token must not remove this observation projection.
- If stable traversal later becomes a product requirement, materialize one
  bounded content-addressed search-result artifact and page that artifact.
  Do not revive a revision token unless it identifies the actual paged result
  set.

### Edit diagnostics — implemented

- Keep model-facing failures to two explicit cases and remove the `recovery`
  action object. `old_string_not_found` returns a short code/message plus at
  most a few bounded `nearMatches` containing line ranges and the actual nearby
  text, and only when an explicit relevance threshold is met.
  `old_string_ambiguous` returns a short code/message plus exact match line
  ranges; repeating the identical matched text adds no information. Never emit
  arbitrary zero-score windows, and never let diagnostic ranking choose the
  edit target.

### Existing-file edit policy — policy and result fields implemented

- Treat read-before-edit as an observed-file behavioral gate, not as strict
  revision CAS. An existing file must have a qualifying observation in the
  model context that produced the edit call. A complete or ranged `read_file`
  result and a verified visible `grep` snippet qualify; durable observations
  that disappeared behind compaction still supply revision evidence but do not
  prove current model visibility.
- If the current SHA still equals the observed SHA, apply the deterministic
  exact edit. If it changed, a single-target edit may proceed only when
  `oldString` still has exactly one exact match in the current file; record the
  optimistic rebase in the result. Do not apply this relaxation to whole-file
  `write_file` replacement or `replaceAll`, which keep an exact current-SHA
  precondition. `write_file` derives that SHA internally from a complete
  visible observation instead of asking the model to echo it. New-file creation
  remains the separate no-clobber path.
- This deliberately permits an exact unique edit outside the lines shown by a
  partial observation, while still requiring that the file was visible and
  refusing similarity edits. Keep the stricter alternative as deferred work:
  require every changed range to fall within visible observed ranges if product
  experience shows that the softer gate permits harmful blind edits.
- Monitor that decision before closing the deferred work. Successful edit
  results should record the observation kind/completeness, whether the changed
  ranges were inside visible ranges, and whether an optimistic rebase occurred.
  Add a bounded runtime/GUI aggregate for out-of-range successes and review
  sampled Sessions without storing additional file content. Define a threshold
  and review window before deciding whether range authorization becomes hard
  policy; the result fields are the first implementation step, while the
  aggregate and product threshold remain TODO.

### Tool-result channels — plain text and bounded inline diff implemented

- Keep the implemented coarse `{ content, output?, error? }` fact shape for
  now. The immediate correction is to render bounded model-facing text per
  tool instead of setting `content` to `JSON.stringify(output)`; structured
  `output` remains available to projections and the GUI.
- Add bounded unified diff data to successful `write_file` and `edit_file`
  structured `output` before building the GUI diff view. Keep the model-facing
  write result concise. Record a truncation flag when the inline diff reaches
  its cap; introduce a content-addressed artifact reference only when real
  large-diff/output consumers justify extending the durable fact protocol.
- Before diff/artifact work expands the durable shape, re-compare the concrete
  consumers and record an ADR or explicit persistence-direction amendment.
  Claude Code separates model tool-result text from structured native results
  such as patches; OpenCode keeps output, metadata, attachments, and timing in
  its tool/message projection; Codex also emits UI-oriented diff/command events
  separately from provider function output. These references do not justify a
  universal `presentation`/`attachments`/`provenance` object before Yakitori
  has callers for those fields.
- When the callers arrive, record semantic, non-derivable data only: an exact
  bounded model-visible result, structured tool output, and content-addressed
  references for oversized payloads. Client-only view state remains outside
  the Session journal.

### Claude Code comparison note

- Current Claude Code is not a strict "complete Read authorizes this exact
  revision" design. It still has an observed-file gate for Edit/Write, but
  since 2.1.89 qualifying `cat` and `sed -n` Bash views can establish that
  observation; a separate Read call is not always required. Version 2.1.208
  changed Edit to proceed after a post-read file modification when the target
  text still matches uniquely, and 2.1.212 fixed resumed edits after an
  `offset`/`limit` read. The resulting policy is closer to "establish an
  observation, then validate the exact unique edit anchor optimistically" than
  to complete-view authorization or strict revision CAS.
- Cache sizing has also changed across releases. The installed 2.1.150 binary
  uses the older 100-path/25-MiB cache with hash-only retention for most entries
  over 4 KiB. The official 2.1.208 changelog describes the newer edit-read
  cache as formerly pinning up to 1,000 full files and now being bounded to
  16 MiB. Do not copy either entry count as a Yakitori invariant; copy the
  durable lesson that the hot projection needs both count/byte bounds and must
  not retain full file bodies when hashes suffice.
