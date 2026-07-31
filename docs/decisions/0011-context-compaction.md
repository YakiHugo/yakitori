# 0011: Record Context Compaction as an Append-Only Checkpoint Fact

## Status

Accepted on 2026-07-31. This decision lands the "Compaction facts" capability
whose shape was pre-agreed in `docs/kernel-persistence-direction.md`; its
trigger — model-context pressure in long Sessions — has a real caller. The
witness-style kernel rules (decision 0007) and the per-fact journal format
(decision 0009) remain in force.

## Context

Model context is rebuilt from recorded facts before every model call. When the
assembled context exceeds the byte/block budgets, `buildModelContext` silently
dropped the oldest turn groups: the model lost all memory of early work with
no record that anything was lost. Long Sessions therefore degraded exactly
where mature products instead compact: Claude Code and Codex both summarize
older history into a checkpoint and keep recent turns verbatim (Codex records
a `compacted` line kind; Claude Code records a `summary` line).

The persistence direction settled the durable shape in advance: an append-only
fact recording the exact source boundary plus a bounded, self-contained
checkpoint, with raw facts retained.

## Decision

### One coarse fact per compaction

`context.compacted` is a new kernel fact type:

```json
{"type":"context.compacted","data":{
  "compactionId":"compaction_…",
  "turnId":"turn_…",
  "throughSeq":41,
  "coveredTurnIds":["turn_…","turn_…"],
  "summary":"…",
  "usage":{"inputTokens":0,"outputTokens":0}}}
```

- `throughSeq` is the Session projection's high-water `seq` observed when the
  summary source was built — the exact source boundary, using the envelope
  coordinate reserved for compaction boundaries.
- `coveredTurnIds` is the cumulative set of terminal Turns this checkpoint
  supersedes, including earlier compactions' coverage. The projection keeps
  only the latest compaction; membership is explicit in the fact, so replay
  needs no per-turn seq ranges.
- Raw facts are never rewritten or removed; compaction is a derived-view
  input, not a history edit. Unknown-to-old-readers safety comes from the
  existing opaque-preservation rule; the envelope `version` stays 1.

The kernel command `recordCompaction` requires the active Turn (compaction
only ever happens inside one) and appends exactly one fact. Shape validation
is the event validator's job; content policy lives in the runner.

### Trigger and execution in the runner

Inside the Turn loop, per model-call iteration, when the freshly built context
reports dropped turns, the runner makes one compaction attempt before the real
model call:

1. Select the longest prefix of the dropped turns whose truncated messages
   (plus the previous summary, when one exists) fit within
   `modelVisibleContextBytes`; any remainder stays uncovered and is folded in
   on a later pressure event. Coverage is therefore always a growing prefix of
   history.
2. Call the **same provider and model** with a fixed checkpoint prompt
   (sections: Goal, Progress, Files, Errors, Next steps), `tools: []`, and no
   snapshot publication — compaction is housekeeping, not turn output.
3. On success, truncate the summary to `compactionSummaryBytes` (16 KiB) and
   record the fact, then rebuild the context (covered turns leave, the
   checkpoint enters as a pinned-until-last-resort
   `<context_compacted>` user message) and proceed.
4. On any failure — provider error, abort, empty summary, append error —
   record nothing and fall back to the previous silent-drop behavior for that
   call. A failed compaction must never fail the Turn.

The compaction call does not count against `modelCallsPerTurn`; its token
usage is aggregated into the Turn's recorded usage. One attempt per iteration
bounds the extra work.

### Context assembly

`buildModelContext` excludes covered turns from history, prepends the
checkpoint message, and exposes the dropped turn groups (with normal
tool-result truncation applied) as the summarization source. The drop loop may
still discard the checkpoint itself as a last resort, preserving the previous
worst-case behavior.

### Limits placement

`compactionSummaryBytes` lives in `RuntimeLimits` only. It is deliberately
**not** added to `TurnExecutionLimits`/`isTurnExecutionContext`: adding a
required key there would invalidate every previously recorded `turn.started`
fact on replay. Compaction policy is runtime configuration, not part of the
recorded turn contract.

## Rejected Alternatives

- **Rewriting or truncating the journal prefix.** Violates append-only
  durability and the witness rule; the persistence direction's "raw facts are
  retained" stands. Prefix truncation may be reassessed with the future fork
  stage, never as part of compaction.
- **Token-based triggering.** No tokenizer exists in the harness today; the
  byte/block budgets are the honest proxy and are already enforced.
- **A separate, cheaper summarization model.** Adds a configuration surface
  with no caller; same-model is the consensus default. Revisit if cost or
  latency data demands it.
- **Counting compaction against the Turn's model-call budget.** Housekeeping
  calls are not agent progress; charging them would turn context pressure into
  spurious `model_budget_exhausted` failures.
- **Durable facts for compaction attempts/failures.** Nothing durable
  happened; the fallback path is visible in behavior (turns keep dropping),
  and failures are logged to the process console.

## Consequences

- Long Sessions degrade by summarization instead of silent amnesia; the
  checkpoint and its exact coverage are inspectable in the journal and the
  GUI (transcript marker entry).
- The model sees an explicit `<context_compacted>` checkpoint and can rely on
  the raw history being preserved on disk for re-inspection through tools.
- Old journals replay unchanged; old readers preserve the new fact type
  opaquely.
- Recovery needs no new rules: the projection folds the latest compaction from
  the journal like any other fact.

## Deferred Work

- Proactive compaction before pressure (e.g. compact idle history between
  Turns) — the current trigger is reactive by design.
- Artifact-store integration for very large summarized sources (see the
  persistence direction's deferred artifact store).
- User-invoked manual compaction — needs a product entry point decision.
