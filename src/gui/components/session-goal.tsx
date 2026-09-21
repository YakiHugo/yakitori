import { Target } from "lucide-react"
import { useState } from "react"
import { useAppStore } from "../store/app-store.ts"
import { SidebarDialog } from "./sidebar-surfaces.tsx"
import { Button } from "./ui/button.tsx"

export function SessionGoal() {
  const session = useAppStore((state) => state.selectedSession)
  const changeSidebar = useAppStore((state) => state.changeSidebar)
  const [editing, setEditing] = useState(false)
  if (session === undefined) return null
  return (
    <>
      {session.goal === undefined ? null : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="inline-flex max-w-72 shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          title={`Session goal: ${session.goal}`}
        >
          <Target className="size-3" />
          <span className="truncate">{session.goal}</span>
        </button>
      )}
      <button
        type="button"
        aria-label={
          session.goal === undefined ? "Set session goal" : "Edit session goal"
        }
        title={
          session.goal === undefined ? "Set session goal" : "Edit session goal"
        }
        onClick={() => setEditing(true)}
        className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent"
      >
        <Target className="size-4" />
      </button>
      {editing ? (
        <SessionGoalDialog
          initialGoal={session.goal ?? ""}
          onSave={async (goal) =>
            changeSidebar({ type: "session", sessionId: session.id, goal })
          }
          onClose={() => setEditing(false)}
        />
      ) : null}
    </>
  )
}

function SessionGoalDialog({
  initialGoal,
  onSave,
  onClose,
}: Readonly<{
  initialGoal: string
  onSave(goal: string | null): Promise<boolean>
  onClose(): void
}>) {
  const [goal, setGoal] = useState(initialGoal)
  const [saving, setSaving] = useState(false)
  const submit = (value: string | null) => {
    if (saving) return
    setSaving(true)
    void onSave(value).then((done) => {
      setSaving(false)
      if (done) onClose()
    })
  }
  return (
    <SidebarDialog title="Session goal" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const text = goal.trim()
          if (text) submit(text)
        }}
      >
        <p className="mb-3 text-sm text-muted-foreground">
          The goal is shared with the Mate on every turn of this conversation
          until it is changed or cleared.
        </p>
        <textarea
          aria-label="Session goal"
          data-autofocus
          value={goal}
          rows={3}
          onChange={(event) => setGoal(event.target.value)}
          placeholder="What should this conversation accomplish?"
          className="w-full resize-none rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="mt-5 flex justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={saving || initialGoal === ""}
            onClick={() => submit(null)}
          >
            Clear goal
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !goal.trim()}>
              Save
            </Button>
          </div>
        </div>
      </form>
    </SidebarDialog>
  )
}
