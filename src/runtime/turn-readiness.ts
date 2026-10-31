export async function waitForTurnReadiness<T>(
  readiness: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw abortError()
  let rejectAborted: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = () => reject(abortError())
  })
  const onAbort = () => rejectAborted?.()
  signal.addEventListener("abort", onAbort, { once: true })
  if (signal.aborted) onAbort()
  try {
    return await Promise.race([readiness, aborted])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

function abortError(): Error {
  return new DOMException("Turn aborted.", "AbortError")
}
