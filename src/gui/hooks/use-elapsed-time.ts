import { useEffect, useState } from "react"

export function useElapsedSeconds(startedAt: string | undefined): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (startedAt === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [startedAt])

  if (startedAt === undefined) return 0
  return Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000))
}
