import type { TurnOutcome } from "./events.ts"

export function canResumeTurn(outcome: TurnOutcome | undefined): boolean {
  if (outcome?.status === "interrupted") return true
  if (outcome?.status !== "failed") return false
  if (outcome.error.details?.serverShouldRetry === false) return false
  return [
    "model.connection_failed",
    "model.stream_disconnected",
    "model.idle_timeout",
    "model.rate_limited",
    "model.server_error",
  ].includes(outcome.error.code ?? "")
}
