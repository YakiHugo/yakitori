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
  const loadSessions = useAppStore((state) => state.loadSessions)

  return (
    <>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-0.5 p-2">
          {sessions.length === 0 ? (
            <p className="px-2 py-4 text-center text-sm text-muted-foreground">
              No sessions
            </p>
          ) : (
            sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                aria-current={session.id === selectedId}
                onClick={() => void selectSession(session.id)}
                className={cn(
                  "rounded-md px-2 py-1.5 text-left hover:bg-accent",
                  session.id === selectedId && "bg-accent",
                )}
              >
                <span className="block truncate text-sm">
                  {session.title ?? "Untitled session"}
                </span>
                <span className="block text-xs text-muted-foreground">
                  seq {session.seq} · {formatTime(session.updatedAt)}
                </span>
              </button>
            ))
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
