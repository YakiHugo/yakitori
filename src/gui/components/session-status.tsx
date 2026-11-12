import { CircleAlert, CirclePause } from "lucide-react"
import type { ApiSessionSummary } from "../../protocol/application.ts"
import { useAppStore } from "../store/app-store.ts"
import {
  sessionReadKey,
  useSessionReadStore,
} from "../store/session-read-store.ts"
import { ActivitySpinner } from "./activity-spinner.tsx"

export function SessionStatus({
  session,
}: Readonly<{ session: ApiSessionSummary }>) {
  const apiBase = useAppStore((state) => state.apiBase)
  const readSeq = useSessionReadStore(
    (state) => state.readSeqs[sessionReadKey(apiBase, session.id)] ?? 0,
  )
  const status =
    session.status === "waiting"
      ? "waiting"
      : session.active || session.status === "working"
        ? "working"
        : session.status === "failed"
          ? "failed"
          : (session.latestCompletionSeq ?? 0) > readSeq
            ? "unread"
            : "idle"
  const label = {
    working: "Working",
    waiting: "Waiting for you",
    failed: "Failed",
    unread: "Unread result",
    idle: undefined,
  }[status]

  return (
    <span
      className="sidebar-session-status"
      data-status={status}
      aria-hidden={status === "idle" ? true : undefined}
      title={label}
    >
      {status === "working" && <ActivitySpinner />}
      {status !== "idle" && status !== "working" && (
        <span
          role="status"
          aria-label={label}
          className="flex items-center justify-center"
        >
          {status === "waiting" && <CirclePause size={14} aria-hidden="true" />}
          {status === "failed" && <CircleAlert size={14} aria-hidden="true" />}
          {status === "unread" && <span className="sidebar-unread-dot" />}
        </span>
      )}
    </span>
  )
}
