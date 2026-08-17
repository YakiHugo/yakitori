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

- `approvalPolicy` in `TurnExecutionContext` is no longer a candidate: the
  runner now reads it at the permission decision (`"never"` skips permission
  prompts, codex's `AskForApproval::Never` analog; opt-in via
  `YAKITORI_APPROVAL_POLICY=never`). (The other recorded candidates —
  `src/actors.ts`, `createToolCallId`, `ItemProjection.metadata`, and the
  model request/response `metadata` fields — were deleted on 2026-08-05.)

## Stale wording in code

- `src/server/handlers.ts` error messages said "in Stage 1" while stage 1 is
  archived (`docs/archive/`). Reworded on 2026-08-05 to name the current
  single-Mate stage restriction without citing a stage number.

## Desktop shell follow-ups (recorded 2026-07-31)

- Packaged builds resolve the workspace once via a native folder picker and
  remember it in `userData/workspace.json` (implemented 2026-08-05);
  cancelling the picker falls back to `~/Yakitori`. Changing the workspace
  later still means editing or deleting that config; an in-app project-open
  flow remains deferred (decision 0010, Deferred Work).
- Static GUI serving is GET-only (no HEAD); add HEAD if a real client needs
  it.
- `pnpm package:desktop` produces an unsigned `dir` build only; signed
  `dmg`, notarization, and auto-update are unconfigured.
- `dev:desktop` now runs its own server on port 4142 with a separate
  `.yakitori-desktop` store (implemented 2026-08-05), so it no longer
  collides with `dev:server` on the port or the runtime lock. Both GUI dev
  servers still share vite port 5173 and now start with `--strictPort`, so a
  conflict fails loudly at startup instead of cross-wiring the shell to the
  other app's GUI.

## Coding-tool protocol status (recorded 2026-08-05)

These items came from comparing the current file tools with the pinned Codex,
OpenCode, Grok, and Claude Code references, an installed Claude Code 2.1.150
binary, and the official Claude Code changelog through 2.1.220. They are
a record of what has landed and what remains deferred, without expanding the
kernel fact protocol ahead of a concrete consumer.

### Live read delivery and request-scoped observation — implemented

- Keep the Session journal as transcript, GUI, debugging, and analysis evidence,
  but do not rebuild file authorization from its complete history. Build one
  immutable `VisibleFileObservations` projection from final, untruncated tool
  results in each exact model request. A historical read dropped by compaction
  grants nothing unless a real read result is delivered again.
- Remove the Session-wide `reads` set and `read_file`'s durable
  `read_unchanged` result. Every successful read records its own bounded,
  self-contained result. Deduplicate only in `buildModelContext`: among
  selected complete results with the same path, SHA, requested range, and
  rendering limits, render one real result and replace the other model-visible
  copies with short references to it. Live partial pages carry no revision and
  are not deduplicated.
- Apply result deduplication before context byte/block accounting and select a
  real representative from the results that remain in the assembled context.
  Compaction, truncation, and resume then recompute the representative from
  durable self-contained facts; no persisted stub can outlive the content it
  references. If only one result remains, it renders normally.
- Use live best-effort page reads: positive 1-based offsets, a 1..2,000 line
  limit, and no continuation revision guard. Only an unclipped read from line 1
  through EOF records a full SHA and metadata. A ranged read establishes
  behavioral edit visibility without pretending to identify a whole-file
  revision.
- Apply visible results in context order. Complete reads, whole-file writes, and
  edit creations establish a revision; a normal edit advances only an already
  visible prerequisite. Results truncated by context assembly grant nothing,
  and a sibling read in the same model response still cannot authorize an
  edit. Successful writes in that response update an in-memory overlay so a
  later write can continue from the just-written revision. A later ranged
  read no longer drops a complete revision that is still in context.

### Grep pagination — implemented

- Until a real search-snapshot consumer exists, align with the reference
  agents' live-search semantics: `offset`/`head_limit` pagination may rerun
  ripgrep against the current workspace and is explicitly best effort. Remove
  the `expected_revision`/`snapshot_token` contract rather than presenting the
  Session observation checkpoint as a workspace snapshot.
- Keep grep as a locator rather than an edit observation. It must not reopen
  matched files, hash full contents, emit `observations`, or authorize an edit;
  the model uses `read_file` before `edit_file`. Monitor the resulting
  grep-to-read-to-edit sequence before reconsidering that boundary.
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
  result qualifies; grep results do not. Observations that disappeared behind
  compaction supply neither visibility nor revision authority.
- If a complete visible SHA still matches, apply the deterministic edit. If it
  changed, a single-target edit may proceed only when `oldString` still has one
  exact unique match in the current file; record the optimistic rebase. A
  ranged read carries no SHA, so it also requires one exact unique current
  anchor. Do not apply this relaxation to whole-file `write_file` replacement
  or `replaceAll`, which require a complete visible revision. `write_file`
  derives that SHA internally instead of asking the model to echo it. New-file
  creation remains the separate no-clobber path: `edit_file` may enter it only
  with an empty `oldString`, which never overwrites an existing target.
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
