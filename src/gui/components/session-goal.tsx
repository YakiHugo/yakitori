import { useTranslation } from "../i18n/use-translation.ts"
import type { Message, Translate } from "../i18n/messages.ts"
import { PanelRight, Pause, Play, Target, Trash2, Undo2, X } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import {
  GoalStatus,
  type GoalStatus as GoalStatusValue,
} from "../../protocol/goal.ts"
import { useAppStore } from "../store/app-store.ts"
import { Button } from "./ui/button.tsx"

export function GoalBar() {
  const { locale, t } = useTranslation()
  const session = useAppStore((state) => state.selectedSession)
  const setGoal = useAppStore((state) => state.setGoal)
  const openGoalEditor = useAppStore((state) => state.openGoalDialog)
  const clearGoal = useAppStore((state) => state.clearGoal)
  const saving = useAppStore((state) =>
    state.inFlightActions.has(`goal:${session?.id}`),
  )
  if (
    session?.goal === undefined ||
    session.goal.status === GoalStatus.Complete
  )
    return null
  const goal = session.goal
  const status = goal.status
  const nextStatus = goalToggleStatus(status)
  return (
    <section
      aria-label={t("Session goal")}
      className="conversation-goal mx-auto w-full max-w-3xl px-4"
    >
      <div className="flex min-w-0 flex-col gap-1 rounded-xl border bg-muted px-3 py-2 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Target className="size-3.5 shrink-0" />
          <span className="text-foreground">{t(goalStatusLabel(status))}</span>
          <span title={t("Goal execution usage")}>
            {goal.tokenBudget === undefined
              ? t("{0} active", formatGoalElapsed(goal.timeUsedSeconds, t))
              : t(
                  "{0} / {1} tokens",
                  goal.tokensUsed.toLocaleString(locale),
                  goal.tokenBudget.toLocaleString(locale),
                )}
          </span>
          <div className="ml-auto flex shrink-0 items-center">
            <GoalIconButton
              label={t("Clear goal")}
              disabled={saving}
              onClick={() => void clearGoal(session.id)}
            >
              <Trash2 className="size-3.5" />
            </GoalIconButton>
            {nextStatus === undefined ? null : (
              <GoalIconButton
                disabled={saving}
                label={
                  nextStatus === GoalStatus.Paused
                    ? t("Pause goal")
                    : t("Resume goal")
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
            <GoalIconButton label={t("Edit goal")} onClick={openGoalEditor}>
              <PanelRight className="size-3.5" />
            </GoalIconButton>
          </div>
        </div>
        <p className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed text-foreground">
          {goal.objective}
        </p>
      </div>
    </section>
  )
}

export function GoalEditor() {
  const { t } = useTranslation()
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
  const saving = useAppStore((state) =>
    state.inFlightActions.has(`goal:${session?.id}`),
  )
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
      aria-label={t("Goal editor")}
      className="goal-editor flex w-[22rem] shrink-0 flex-col border-l bg-background"
    >
      <div className="goal-editor-header flex h-12 items-center justify-between gap-2 border-b px-3">
        <span className="truncate text-sm text-muted-foreground">
          {updatedAgoLabel(session.goal?.updatedAt, now, t)}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label={t("Close goal editor")}
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
            {t("Revert")}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={saving || !draft.trim() || !dirty || !validBudget}
            onClick={() => {
              const text = draft.trim()
              if (!text || !validBudget) return
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
                if (
                  !done ||
                  useAppStore.getState().selection.sessionId !== session.id
                )
                  return
                const saved = useAppStore.getState().selectedSession?.goal
                setSavedObjective(saved?.objective ?? "")
                setSavedBudget(
                  saved?.tokenBudget === tokenBudget
                    ? budgetDraft.trim()
                    : (saved?.tokenBudget?.toString() ?? ""),
                )
              })
            }}
          >
            {t("Save")}
          </Button>
        </div>
      </div>
      <textarea
        aria-label={t("Goal")}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={t("What should this conversation accomplish?")}
        className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 text-sm outline-none"
      />
      <div className="flex flex-col gap-2 border-t p-4">
        <label htmlFor="goal-token-budget" className="text-sm">
          {t("Token budget (optional)")}
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
          placeholder={t("No token budget")}
          className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <p
          id="goal-token-budget-help"
          className="text-xs text-muted-foreground"
        >
          {validBudget
            ? t("Leave blank to run without a token budget.")
            : t("Enter a positive whole number of tokens.")}
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

function goalStatusLabel(status: GoalStatusValue): Message {
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

function formatGoalElapsed(seconds: number, t: Translate): string {
  const whole = Math.max(0, Math.floor(seconds))
  if (whole < 60) return t("{0}s", whole)
  const minutes = Math.floor(whole / 60)
  if (minutes < 60) return t("{0}m", minutes)
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? t("{0}h", hours) : t("{0}h {1}m", hours, rest)
}

function updatedAgoLabel(
  updatedAt: string | undefined,
  now: number,
  t: Translate,
): string {
  if (updatedAt === undefined) return t("Not saved yet")
  const updated = Date.parse(updatedAt)
  if (!Number.isFinite(updated)) return t("Updated")
  const minutes = Math.max(0, Math.floor((now - updated) / 60_000))
  if (minutes === 0) return t("Just updated")
  return minutes === 1
    ? t("Updated 1 minute ago")
    : t("Updated {0} minutes ago", minutes)
}
