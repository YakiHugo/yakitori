// Configuration failures are actionable input errors. Unexpected exceptions and
// filesystem failures retain their original identity for the host error boundary.
export class ConfigurationError extends Error {
  readonly code: "syntax" | "invalid_value"
  readonly path?: string

  constructor(
    message: string,
    options: ErrorOptions & {
      code?: "syntax" | "invalid_value"
      path?: string
    } = {},
  ) {
    super(message, options)
    this.name = "ConfigurationError"
    this.code = options.code ?? "invalid_value"
    if (options.path !== undefined) this.path = options.path
  }
}
