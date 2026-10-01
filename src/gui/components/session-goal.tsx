import { PanelRight, Pause, Play, Target, Trash2, Undo2, X } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import {
  GoalStatus,
  type GoalStatus as GoalStatusValue,
  goalElapsedSeconds,
} from "../../core/goal.ts"
import { useAppStore } from "../store/app-store.ts"
import { Button } from "./ui/button.tsx"

export function GoalBar() {
  const session = useAppStore((state) => state.selectedSession)
  const changeSidebar = useAppStore((state) => state.changeSidebar)
  const openGoalEditor = useAppStore((state) => state.openGoalDialog)
  const [now, setNow] = useState(() => Date.now())
  const status = session?.goalStatus ?? GoalStatus.Active
  const ticking = session?.goal !== undefined && status === GoalStatus.Active
  useEffect(() => {
    if (!ticking) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [ticking])
  if (session?.goal === undefined) return null
  const elapsed = goalElapsedSeconds({
    status,
    ...(session.goalUpdatedAt === undefined
      ? {}
      : { updatedAt: session.goalUpdatedAt }),
    ...(session.goalTimeUsedSeconds === undefined
      ? {}
      : { timeUsedSeconds: session.goalTimeUsedSeconds }),
    now,
  })
  const nextStatus = goalToggleStatus(status)
  return (
    <div className="mx-auto mb-2 flex w-full max-w-3xl items-center gap-2 rounded-xl border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
      <Target className="size-3.5 shrink-0" />
      <span className="shrink-0 text-foreground">
        {goalStatusLabel(status)}
      </span>
      <span className="min-w-0 truncate">{session.goal}</span>
      <span className="shrink-0">· {formatGoalElapsed(elapsed)}</span>
      <div className="ml-auto flex shrink-0 items-center">
        <GoalIconButton
          label="Clear goal"
          onClick={() =>
            void changeSidebar({
              type: "session",
              sessionId: session.id,
              goal: null,
            })
          }
        >
          <Trash2 className="size-3.5" />
        </GoalIconButton>
        {nextStatus === undefined ? null : (
          <GoalIconButton
            label={
              nextStatus === GoalStatus.Paused ? "Pause goal" : "Resume goal"
            }
            onClick={() =>
              void changeSidebar({
                type: "session",
                sessionId: session.id,
                goalStatus: nextStatus,
                goalUpdatedAt: new Date().toISOString(),
                goalTimeUsedSeconds: elapsed,
              })
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
  const changeSidebar = useAppStore((state) => state.changeSidebar)
  const goalDialogRevision = useAppStore((state) => state.goalDialogRevision)
  const [open, setOpen] = useState(false)
  const [seenRevision, setSeenRevision] = useState(goalDialogRevision)
  const [draft, setDraft] = useState(session?.goal ?? "")
  const [savedObjective, setSavedObjective] = useState(session?.goal ?? "")
  const [saving, setSaving] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [editorSessionId, setEditorSessionId] = useState(session?.id)
  const [lastSyncedGoal, setLastSyncedGoal] = useState(session?.goal)
  if (session?.id !== editorSessionId) {
    setEditorSessionId(session?.id)
    setLastSyncedGoal(session?.goal)
    setDraft(session?.goal ?? "")
    setSavedObjective(session?.goal ?? "")
  }
  // Follow clears and replacements that arrive from the goal bar or another
  // client while the editor is open, unless the user has unsaved edits.
  if (session?.goal !== lastSyncedGoal) {
    setLastSyncedGoal(session?.goal)
    if (draft.trim() === savedObjective.trim()) {
      setDraft(session?.goal ?? "")
      setSavedObjective(session?.goal ?? "")
    }
  }
  if (goalDialogRevision !== seenRevision) {
    setSeenRevision(goalDialogRevision)
    setOpen(true)
    setDraft(session?.goal ?? "")
    setSavedObjective(session?.goal ?? "")
  }
  useEffect(() => {
    if (!open) return
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [open])
  if (!open || session === undefined) return null
  const dirty = draft.trim() !== savedObjective.trim()
  const elapsed = goalElapsedSeconds({
    ...(session.goalStatus === undefined
      ? {}
      : { status: session.goalStatus }),
    ...(session.goalUpdatedAt === undefined
      ? {}
      : { updatedAt: session.goalUpdatedAt }),
    ...(session.goalTimeUsedSeconds === undefined
      ? {}
      : { timeUsedSeconds: session.goalTimeUsedSeconds }),
    now: Date.now(),
  })
  return (
    <aside className="flex w-[22rem] shrink-0 flex-col border-l bg-background">
      <div className="flex h-12 items-center justify-between gap-2 border-b px-3">
        <span className="text-sm text-muted-foreground">
          {updatedAgoLabel(session.goalUpdatedAt, now)}
        </span>
        <div className="flex items-center gap-1">
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
            onClick={() => setDraft(savedObjective)}
          >
            <Undo2 />
            Revert
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={saving || !draft.trim() || !dirty}
            onClick={() => {
              const text = draft.trim()
              if (!text) return
              setSaving(true)
              void changeSidebar({
                type: "session",
                sessionId: session.id,
                goal: text,
                ...(session.goal === undefined
                  ? {
                      goalStatus: GoalStatus.Active,
                      goalTimeUsedSeconds: 0,
                      goalInputId: null,
                    }
                  : { goalTimeUsedSeconds: elapsed }),
                goalUpdatedAt: new Date().toISOString(),
              }).then((done) => {
                setSaving(false)
                if (!done) return
                setSavedObjective(text)
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
