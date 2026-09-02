export type OperationalFailure = Readonly<{
  component: string
  operation: string
  cause: unknown
  sessionId?: string
  turnId?: string
  eventRange?: Readonly<{
    from: number
    through: number
  }>
}>

export type OperationalFailureReporter = (
  failure: OperationalFailure,
) => void | Promise<void>

export const consoleOperationalFailureReporter: OperationalFailureReporter = (
  failure,
) => {
  const context = [
    failure.sessionId === undefined
      ? undefined
      : `session=${failure.sessionId}`,
    failure.turnId === undefined ? undefined : `turn=${failure.turnId}`,
    failure.eventRange === undefined
      ? undefined
      : `events=${String(failure.eventRange.from)}..${String(failure.eventRange.through)}`,
  ]
    .filter((part) => part !== undefined)
    .join(" ")
  console.error(
    `yakitori: ${failure.component}.${failure.operation} failed${context.length === 0 ? "" : ` (${context})`}`,
    failure.cause,
  )
}

// Observability is not part of the operation's success contract. A broken
// reporter must never roll back durable work or break lifecycle cleanup.
export function reportOperationalFailure(
  reporter: OperationalFailureReporter,
  failure: OperationalFailure,
): void {
  try {
    const result = reporter(failure)
    if (result !== undefined) {
      void Promise.resolve(result).catch((reporterError: unknown) => {
        reportReporterFailure(failure, reporterError)
      })
    }
  } catch (reporterError) {
    reportReporterFailure(failure, reporterError)
  }
}

function reportReporterFailure(
  failure: OperationalFailure,
  reporterError: unknown,
): void {
  try {
    console.error("yakitori: operational failure reporter failed", {
      failure,
      reporterError,
    })
  } catch {
    // There is no remaining in-process reporting boundary.
  }
}
