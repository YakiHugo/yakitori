import { useEffect, useState } from "react"
import type { ActiveModelRetry, TurnTiming } from "../execution-view.ts"
import { formatElapsed } from "../lib/format.ts"

export function TurnActivityLabel({
  id,
  active,
  timing,
  retry,
}: Readonly<{
  id: string
  active: boolean
  timing: TurnTiming | undefined
  retry: ActiveModelRetry | undefined
}>) {
  const [now, setNow] = useState(Date.now)
  const startedAt = timing?.startedAt
  useEffect(() => {
    if (!active || startedAt === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active, startedAt])
  const start = startedAt === undefined ? undefined : Date.parse(startedAt)
  const end = active
    ? now
    : timing?.completedAt === undefined
      ? undefined
      : Date.parse(timing.completedAt)
  const elapsed =
    start !== undefined && end !== undefined
      ? formatElapsed(Math.max(0, Math.floor((end - start) / 1000)))
      : undefined
  const retryLabel =
    retry?.kind === "rate_limited"
      ? "Waiting for rate limit"
      : retry?.kind === "connection_failed" ||
          retry?.kind === "stream_disconnected" ||
          retry?.kind === "idle_timeout"
        ? "Reconnecting"
        : "Retrying request"

  return (
    <span
      id={id}
      className={active ? "tool-running-label" : undefined}
      role={active ? "status" : undefined}
    >
      {retry
        ? `${retryLabel} · attempt ${retry.nextAttempt}/${retry.maxAttempts}`
        : active
          ? elapsed === undefined
            ? "Working"
            : "Working for"
          : elapsed === undefined
            ? "Activity"
            : "Worked for"}
      {elapsed === undefined ? null : (
        <span className="tabular-nums" aria-live="off">
          {retry ? " · " : " "}
          {elapsed}
        </span>
      )}
    </span>
  )
}
