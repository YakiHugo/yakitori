import { useEffect, useState } from "react"

// Codex's terminal-title spinner: ten braille frames at 100ms. It is the one
// codex UI spinner whose frame sequence ships in the reference source.
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const
const FRAME_INTERVAL_MS = 100

export function ActivitySpinner() {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const timer = window.setInterval(
      () => setFrame((current) => (current + 1) % FRAMES.length),
      FRAME_INTERVAL_MS,
    )
    return () => window.clearInterval(timer)
  }, [])
  return (
    <span
      className="session-activity-spinner"
      role="status"
      aria-label="Working"
    >
      {FRAMES[frame]}
    </span>
  )
}
