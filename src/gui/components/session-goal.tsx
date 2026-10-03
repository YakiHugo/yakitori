import { PanelRight, Pause, Play, Target, Trash2, Undo2, X } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import {
  GoalStatus,
  type GoalStatus as GoalStatusValue,
} from "../../core/goal.ts"
import { useAppStore } from "../store/app-store.ts"
import { Button } from "./ui/button.tsx"

export function GoalBar() {
  const session = useAppStore((state) => state.selectedSession)
  const setGoal = useAppStore((state) => state.setGoal)
  const openGoalEditor = useAppStore((state) => state.openGoalDialog)
  const clearGoal = useAppStore((state) => state.clearGoal)
  const saving = useAppStore((state) =>
    state.inFlightActions.has(`goal:${session?.id}`),
  )
  if (session?.goal === undefined) return null
  const goal = session.goal
  const status = goal.status
  const nextStatus = goalToggleStatus(status)
  return (
    <div className="mx-auto mb-2 flex w-full max-w-3xl items-center gap-2 rounded-xl border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
      <Target className="size-3.5 shrink-0" />
      <span className="shrink-0 text-foreground">
        {goalStatusLabel(status)}
      </span>
      <span className="min-w-0 truncate">{goal.objective}</span>
      <span className="shrink-0">
        ·{" "}
        {goal.tokenBudget === undefined
          ? formatGoalElapsed(goal.timeUsedSeconds)
          : `${goal.tokensUsed.toLocaleString()} / ${goal.tokenBudget.toLocaleString()} tokens`}
      </span>
      <div className="ml-auto flex shrink-0 items-center">
        <GoalIconButton
          label="Clear goal"
          disabled={saving}
          onClick={() => void clearGoal(session.id)}
        >
          <Trash2 className="size-3.5" />
        </GoalIconButton>
        {nextStatus === undefined ? null : (
          <GoalIconButton
            disabled={saving}
            label={
              nextStatus === GoalStatus.Paused ? "Pause goal" : "Resume goal"
            }
            onClick={() =>
              void setGoal({ sessionId: session.id, status: nextStatus })
            }
          >
            {nextStatus === GoalStatus.Paused ? (
              <Pause className="size-3.5" />
            ) : (
              <Play className="size-3.5" />
            )}
          </GoalIconButton>
        )}
        <GoalIconButton label="Edit goal" onClick={openGoalEditor}>
          <PanelRight className="size-3.5" />
        </GoalIconButton>
      </div>
    </div>
  )
}

export function GoalEditor() {
  const session = useAppStore((state) => state.selectedSession)
  const setGoal = useAppStore((state) => state.setGoal)
  const goalDialogRevision = useAppStore((state) => state.goalDialogRevision)
  const [open, setOpen] = useState(false)
  const [seenRevision, setSeenRevision] = useState(goalDialogRevision)
  const [draft, setDraft] = useState(session?.goal?.objective ?? "")
  const [savedObjective, setSavedObjective] = useState(
    session?.goal?.objective ?? "",
  )
  const [budgetDraft, setBudgetDraft] = useState(
    session?.goal?.tokenBudget?.toString() ?? "",
  )
  const [savedBudget, setSavedBudget] = useState(budgetDraft)
  const [saving, setSaving] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [editorSessionId, setEditorSessionId] = useState(session?.id)
  const [lastSyncedGoal, setLastSyncedGoal] = useState(session?.goal)
  if (session?.id !== editorSessionId) {
    setEditorSessionId(session?.id)
    setLastSyncedGoal(session?.goal)
    setDraft(session?.goal?.objective ?? "")
    setSavedObjective(session?.goal?.objective ?? "")
    setBudgetDraft(session?.goal?.tokenBudget?.toString() ?? "")
    setSavedBudget(session?.goal?.tokenBudget?.toString() ?? "")
  }
  // Follow clears and replacements that arrive from the goal bar or another
  // client while the editor is open, unless the user has unsaved edits.
  if (session?.goal !== lastSyncedGoal) {
    setLastSyncedGoal(session?.goal)
    if (
      draft.trim() === savedObjective.trim() &&
      budgetDraft.trim() === savedBudget.trim()
    ) {
      setDraft(session?.goal?.objective ?? "")
      setSavedObjective(session?.goal?.objective ?? "")
      setBudgetDraft(session?.goal?.tokenBudget?.toString() ?? "")
      setSavedBudget(session?.goal?.tokenBudget?.toString() ?? "")
    }
  }
  if (goalDialogRevision !== seenRevision) {
    setSeenRevision(goalDialogRevision)
    setOpen(true)
    setDraft(session?.goal?.objective ?? "")
    setSavedObjective(session?.goal?.objective ?? "")
    setBudgetDraft(session?.goal?.tokenBudget?.toString() ?? "")
    setSavedBudget(session?.goal?.tokenBudget?.toString() ?? "")
  }
  useEffect(() => {
    if (!open) return
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [open])
  if (!open || session === undefined) return null
  const dirty =
    draft.trim() !== savedObjective.trim() ||
    budgetDraft.trim() !== savedBudget.trim()
  const tokenBudget = budgetDraft.trim() === "" ? null : Number(budgetDraft)
  const validBudget =
    tokenBudget === null ||
    (Number.isSafeInteger(tokenBudget) && tokenBudget > 0)
  const replaceTerminal =
    session.goal?.status === GoalStatus.Complete ||
    session.goal?.status === GoalStatus.BudgetLimited
  return (
    <aside
      aria-label="Goal editor"
      className="flex w-[22rem] shrink-0 flex-col border-l bg-background"
    >
      <div className="goal-editor-header flex h-12 items-center justify-between gap-2 border-b px-3">
        <span className="truncate text-sm text-muted-foreground">
          {updatedAgoLabel(session.goal?.updatedAt, now)}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label="Close goal editor"
            onClick={() => setOpen(false)}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!dirty || saving}
            onClick={() => {
              setDraft(savedObjective)
              setBudgetDraft(savedBudget)
            }}
          >
            <Undo2 />
            Revert
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={saving || !draft.trim() || !dirty || !validBudget}
            onClick={() => {
              const text = draft.trim()
              if (!text || !validBudget) return
              setSaving(true)
              void setGoal({
                sessionId: session.id,
                objective: text,
                ...(session.goal === undefined || replaceTerminal
                  ? { status: GoalStatus.Active, inputId: null }
                  : {}),
                ...(budgetDraft.trim() === savedBudget.trim() &&
                !replaceTerminal
                  ? {}
                  : { tokenBudget }),
              }).then((done) => {
                setSaving(false)
                if (
                  !done ||
                  useAppStore.getState().selection.sessionId !== session.id
                )
                  return
                setSavedObjective(text)
                setSavedBudget(budgetDraft.trim())
              })
            }}
          >
            Save
          </Button>
        </div>
      </div>
      <textarea
        aria-label="Goal"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="What should this conversation accomplish?"
        className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 text-sm outline-none"
      />
      <div className="flex flex-col gap-2 border-t p-4">
        <label htmlFor="goal-token-budget" className="text-sm">
          Token budget (optional)
        </label>
        <input
          id="goal-token-budget"
          type="number"
          min="1"
          step="1"
          value={budgetDraft}
          onChange={(event) => setBudgetDraft(event.target.value)}
          aria-invalid={!validBudget}
          aria-describedby="goal-token-budget-help"
          placeholder="No token budget"
          className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <p
          id="goal-token-budget-help"
          className="text-xs text-muted-foreground"
        >
          {validBudget
            ? "Leave blank to run without a token budget."
            : "Enter a positive whole number of tokens."}
        </p>
      </div>
    </aside>
  )
}

function GoalIconButton({
  label,
  disabled,
  onClick,
  children,
}: Readonly<{
  label: string
  disabled?: boolean
  onClick(): void
  children: ReactNode
}>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-md p-1.5 hover:bg-accent hover:text-foreground disabled:opacity-50"
    >
      {children}
    </button>
  )
}

function goalStatusLabel(status: GoalStatusValue): string {
  switch (status) {
    case GoalStatus.Paused:
      return "Paused goal"
    case GoalStatus.Blocked:
      return "Goal stalled"
    case GoalStatus.UsageLimited:
      return "Goal usage limited"
    case GoalStatus.BudgetLimited:
      return "Goal limited"
    case GoalStatus.Complete:
      return "Goal achieved"
    default:
      return "Pursuing goal"
  }
}

function goalToggleStatus(
  status: GoalStatusValue,
): GoalStatusValue | undefined {
  switch (status) {
    case GoalStatus.Active:
      return GoalStatus.Paused
    case GoalStatus.Paused:
    case GoalStatus.Blocked:
    case GoalStatus.UsageLimited:
      return GoalStatus.Active
    default:
      return undefined
  }
}

function formatGoalElapsed(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  if (whole < 60) return `${whole}s`
  const minutes = Math.floor(whole / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

function updatedAgoLabel(updatedAt: string | undefined, now: number): string {
  if (updatedAt === undefined) return "Not saved yet"
  const updated = Date.parse(updatedAt)
  if (!Number.isFinite(updated)) return "Updated"
  const minutes = Math.max(0, Math.floor((now - updated) / 60_000))
  if (minutes === 0) return "Just updated"
  return minutes === 1
    ? "Updated 1 minute ago"
    : `Updated ${minutes} minutes ago`
}
