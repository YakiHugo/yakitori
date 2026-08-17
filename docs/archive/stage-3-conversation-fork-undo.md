# Stage 3: Conversation Fork Undo

> Archived on 2026-08-17 after Stage 3 shipped. Historical record only; do
> not implement from this plan.

This was the active stage plan. It was written for a coding agent implementing
the work one reviewable step at a time. Read `AGENTS.md` and
`docs/decisions/0007-kernel-as-witness.md` before starting.

## Decision summary

Undo and message-edit follow Codex's model: **files are never rolled back**.
Undoing to (or editing) an earlier user message creates a **new session** that
forks from the original at that point; the original session is preserved
untouched. The forked session carries a durable record of the fork, and the
model context of the forked session includes a notice telling the agent that
files and environment may reflect work done after the fork point by the
abandoned branch.

Rejected alternatives (full rationale goes into ADR 0024):

- Shadow-git workspace snapshots (the uncommitted implementation being
  removed in step 0): data-loss failure modes, large operational surface, and
  the industry has moved away from it for user-facing rewind.
- Per-file copy checkpoints (Claude Code style): legitimate later work, not
  part of this stage.
- Same-session history truncation: violates the append-only event log and
  destroys the abandoned branch.

## Key facts about the current code

- The event log is strictly linear and append-only per session; `seq` starts
  at 1 per session and `SessionCreated` occupies seq 1
  (`src/kernel/session-kernel.ts:297-313`).
- `SessionCreated.data.parentSessionId` is plumbed end-to-end (event
  validation, projection, summaries, cached-projection format, server
  protocol/handlers) but never set by any caller. `InputAdmitted.data.parentInputId`
  and `TurnStarted.data.parentTurnId` likewise exist with existence
  validation and are never set.
- `createSession` accepts `parentSessionId` in its input
  (`src/kernel/session-kernel.ts:85,308`); the server create-session route
  already echoes it (`src/server/handlers.ts:362-373`).
- There is no event-copy operation in the store
  (`src/kernel/event-store.ts`, `src/kernel/jsonl-event-store.ts`).
- Context assembly precedent for injected notices: `terminalTurnNotice`
  (`src/runtime/model-context.ts:323-335`) renders user-role
  `<turn_cancelled>`/`<turn_failed>`/`<turn_interrupted>` messages; the
  compaction checkpoint renders `<context_compacted>`
  (`src/runtime/model-context.ts:158-178`).
- A new session runs by admitting an input and `runner.wake(sessionId)`
  (`src/runtime/session-runner.ts:176`, recovery usage in
  `src/runtime/recovery.ts:81-93`).
- `deleteSession` refuses while a turn is active or inputs are queued
  (`src/kernel/session-kernel.ts:326-340`) — the fork guard should match.

## How to execute this plan

- Implement the numbered steps in order. Do not begin the next step until the
  current step's tests and `pnpm check` pass.
- Keep each step reviewable (under 500 lines of complex logic). Split at the
  smallest coherent boundary rather than pulling later scope forward.
- Preserve unrelated working-tree changes. Never make code or tests depend on
  `.references/`.
- Test behavior through public contracts and the durable journal. Use the
  scripted faux provider; `pnpm test` and `pnpm check` must never need
  network access or API keys.
- After each step, report: files changed, behavior added, commands run, and
  any deviation from this plan. Change the plan first if a boundary must
  change.

Suggested branch: `feat/conversation-fork-undo`. Do not commit unless the
operator asks.

Track progress here. Mark a step complete only after its exit criteria and
`pnpm check` pass:

| Step | Status | Deliverable |
| ---: | :---: | --- |
| 0 | [x] | Shadow-git snapshot feature fully reverted |
| 1 | [x] | ADR 0024 records the fork-undo decision |
| 2 | [x] | Kernel fork: event-prefix copy + `forkSession` |
| 3 | [x] | Server fork route + optional input re-admission |
| 4 | [x] | Fork divergence notice in model context |
| 5 | [x] | GUI undo/edit affordances, verified in browser |

## Step 0: Revert the shadow-git snapshot feature

The workspace-snapshot feature is entirely uncommitted. Remove it:

Delete (untracked):

- `src/runtime/workspace-snapshot.ts`
- `src/runtime/tools/workspace.ts`
- `test/runtime/workspace-snapshot.test.ts`
- `test/runtime/tools/workspace.test.ts`
- `docs/decisions/0024-workspace-snapshots.md`

Restore with `git checkout --` (all feature hunks are additive):

- `src/runtime/index.ts`
- `src/runtime/tools/index.ts`
- `src/runtime/tools/registry.ts`
- `src/runtime/tools/types.ts`
- `src/runtime/session-runner.ts`
- `src/server/application.ts`
- `src/runtime/prompts/default.md`, `anthropic.md`, `gpt.md`, `kimi.md`
- `test/runtime/session-runner.test.ts`
- `test/runtime/tools/file-tools.test.ts`

Keep the unrelated `AGENTS.md` changes (reference-sourcing policy).

Exit criteria: `git status` shows only `AGENTS.md` modified; `pnpm check`
passes.

## Step 1: ADR 0024

Write `docs/decisions/0024-conversation-fork-undo.md` (the number frees up in
step 0). Follow the format of the existing ADRs. Content:

- Decision: undo/edit = fork into a new session; files never rolled back;
  fork is recorded durably; forked sessions inject a divergence notice into
  model context.
- Reference basis per the AGENTS.md sourcing policy: Codex (first-party)
  makes conversation rollback explicitly not revert the filesystem; Kimi Code
  (first-party) forks sessions on `/undo` and preserves the original.
- Rejected: shadow-git snapshots (cite the failure modes found during review:
  restore could delete user files when `.gitignore` changed, restore was
  irreversible with no redo baseline, stale `index.lock` bricking, nested
  repository blindness); same-session truncation (append-only log); per-file
  copy checkpoints (deferred as possible later work, not this stage).

Exit criteria: ADR committed to the working tree; no code changes.

## Step 2: Kernel fork

Add `SessionKernel.forkSession({ sessionId, atInputId, reason })`:

- Validate: session exists; `atInputId` names an admitted input of that
  session; no turn is active and no inputs are queued (same guard shape as
  `deleteSession`).
- Create the target session with the source session's title, working directory,
  Mate binding, and metadata, plus
  `SessionCreated.data.parentSessionId = sourceId`. Extend
  `SessionCreated.data` with fork metadata: `forkedFromInputId` and a
  `forkReason: "undo" | "edit"`. Update event validation
  (`src/kernel/events.ts`), the projector (`src/kernel/session-projector.ts`),
  session summaries, and the cached-projection format
  (`src/kernel/jsonl-event-store-format.ts`) to carry the new fields.
- Add one store operation that atomically materializes the target's
  `SessionCreated` and copied prefix, so a failed copy never exposes a partial
  fork. Copy all events of the source
  session after its `SessionCreated` (seq >= 2) up to but excluding the
  `InputAdmitted` event for `atInputId`, appended to the target session.
  Because `SessionCreated` occupies seq 1 in both sessions, copy source seq N
  to target seq N verbatim (preserve `id`, `seq`, `createdAt`; rewrite only
  `sessionId`). Copy nothing for seqs beyond the cut point.
- Compaction events inside the copied prefix carry `throughSeq`/`coveredTurnIds`
  that remain valid under seq preservation; copy them verbatim.
- The operation must be serialized with other appends to the source session
  (the fork guard already excludes active turns; use the store's existing
  per-session append discipline).
- Copied event timestamps can predate the target `SessionCreated`; projection
  `updatedAt` therefore takes the maximum observed timestamp rather than the
  last applied timestamp.

Tests (`test/kernel/`): fork copies exactly the prefix; seqs and ids
preserved; projection of the forked session equals the source projection
truncated at the cut point plus `parentSessionId`/fork metadata; fork refuses
with an active turn; fork at the first input yields a session containing only
`SessionCreated`.

Exit criteria: tests pass; `pnpm check` passes.

## Step 3: Server fork route

- `POST /sessions/:id/fork` with body
  `{ atInputId, reason, content?, modelSelection? }`
  (`src/server/protocol.ts`, `handlers.ts`, `http.ts`).
- Handler: call `forkSession`; when `content` is present, admit it into the
  forked session as a user input with `InputAdmitted.data.parentInputId =
  atInputId` and the inherited GUI model selection, then `runner.wake` the
  forked session. This one cross-session
  parent is valid only when it matches the session's `forkedFromInputId`; all
  other input parents retain same-session existence validation. When `content` is
  absent, return the forked session without starting a turn (pure undo;
  the user types the next message into it).
- Response: the new session summary including `parentSessionId` and fork
  metadata (protocol type updates; `parentSessionId` is already echoed on
  create — mirror that).

Tests (`test/server/`): route validation errors; fork + content drives a turn
in the new session via the faux provider; source session untouched.

Exit criteria: tests pass; `pnpm check` passes.

## Step 4: Divergence notice in model context

In `src/runtime/model-context.ts`, when assembling context for a session
whose projection carries fork metadata, inject one user-role notice
immediately after the compaction-checkpoint slot, following the
`terminalTurnNotice` precedent. The notice must state, in effect:

> This session continues a conversation that was undone/edited at an earlier
> point. Actions taken after that point in the previous session were NOT
> rolled back: files, command effects, and environment may reflect them. Do
> not rely on remembered file contents or tool results from before this
> message; re-read files before editing them.

Wrap it in a dedicated tag (e.g. `<session_forked>`), include the fork reason
(`undo` vs `edit`). It repeats on every assembled context of the forked
session and ages out naturally with turn-group dropping — that is acceptable;
do not build one-shot machinery.

Tests (`test/runtime/`): forked session's assembled context contains the
notice before the first turn group; non-forked sessions never contain it;
reason `edit` vs `undo` renders accordingly.

Exit criteria: tests pass; `pnpm check` passes.

## Step 5: GUI

- Message-level actions on user messages: "Undo to here" (fork without
  content, focus the forked session's composer) and "Edit & resubmit" (fork
  with edited content).
- Forked sessions show a small badge/link to the parent session in the
  thread list or header.
- No file-state promises anywhere in copy: the UI must not imply files are
  restored.

Per AGENTS.md, verify visible behavior in a browser before finalizing and
record the exact verification command or URL in the final response.

Exit criteria: browser-verified; `pnpm check` passes.

## Explicitly out of scope for this stage

- File rollback of any kind (shadow git, file copies).
- Forking mid-turn or cancelling the source session's active turn implicitly
  (GUI cancels first via the existing turn-cancel route).
- Garbage collection or linking of abandoned branches beyond
  `parentSessionId`.
- Room/Mate collaboration semantics for forks.
