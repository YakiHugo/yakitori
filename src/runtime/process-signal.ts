import type { ChildProcess } from "node:child_process"

// Managed pipe commands and hooks start in their own process group so stopping
// the shell also signals its foreground children. Already-exited groups are normal.
export function signalProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined)
      process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    )
      return
    throw error
  }
}
