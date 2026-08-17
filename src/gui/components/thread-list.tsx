import { GitFork, Trash2 } from "lucide-react"
import { useState } from "react"
import { formatTime } from "../lib/format.ts"
import { cn } from "../lib/utils.ts"
import { useAppStore } from "../store/app-store.ts"
import { Button } from "./ui/button.tsx"
import { ScrollArea } from "./ui/scroll-area.tsx"

export function ThreadList() {
  const sessions = useAppStore((state) => state.sessions)
  const selectedId = useAppStore((state) => state.selection.sessionId)
  const nextCursor = useAppStore((state) => state.nextCursor)
  const selectSession = useAppStore((state) => state.selectSession)
  const deleteSession = useAppStore((state) => state.deleteSession)
  const loadSessions = useAppStore((state) => state.loadSessions)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | undefined>()

  return (
    <>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-0.5 p-2">
          {sessions.length === 0 ? (
            <p className="px-2 py-4 text-center text-sm text-muted-foreground">
              No sessions
            </p>
          ) : (
            sessions.map((session) =>
              pendingDeleteId === session.id ? (
                <div
                  key={session.id}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5"
                >
                  <span className="flex-1 text-xs text-muted-foreground">
                    Delete? This cannot be undone.
                  </span>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      setPendingDeleteId(undefined)
                      void deleteSession(session.id)
                    }}
                  >
                    Confirm
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setPendingDeleteId(undefined)}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <div key={session.id} className="group flex items-center">
                  <button
                    type="button"
                    aria-current={session.id === selectedId}
                    onClick={() => void selectSession(session.id)}
                    className={cn(
                      "min-w-0 flex-1 rounded-md px-2 py-1.5 text-left hover:bg-accent",
                      session.id === selectedId && "bg-accent",
                    )}
                  >
                    <span className="flex items-center gap-1.5 truncate text-sm">
                      {session.parentSessionId !== undefined ? (
                        <GitFork className="size-3 shrink-0 text-muted-foreground" />
                      ) : null}
                      <span className="truncate">
                        {session.title ?? "Untitled session"}
                      </span>
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      seq {session.seq} · {formatTime(session.updatedAt)}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label="Delete session"
                    onClick={() => setPendingDeleteId(session.id)}
                    className="rounded-md p-1.5 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              ),
            )
          )}
        </div>
      </ScrollArea>
      {nextCursor !== undefined && (
        <div className="border-t p-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full"
            onClick={() => void loadSessions({ append: true })}
          >
            More
          </Button>
        </div>
      )}
    </>
  )
}
