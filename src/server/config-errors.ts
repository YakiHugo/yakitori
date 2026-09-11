export type ConfigTextPosition = Readonly<{
  line: number
  column: number
}>

export type ConfigTextRange = Readonly<{
  start: ConfigTextPosition
  end: ConfigTextPosition
}>

// Configuration failures are actionable input errors. Unexpected exceptions and
// filesystem failures retain their original identity for the host error boundary.
export class ConfigurationError extends Error {
  readonly code: "syntax" | "invalid_value" | "unknown_field"
  readonly path?: string
  readonly range?: ConfigTextRange
  readonly keyPath?: string

  constructor(
    message: string,
    options: ErrorOptions & {
      code?: "syntax" | "invalid_value" | "unknown_field"
      path?: string
      range?: ConfigTextRange
      keyPath?: string
    } = {},
  ) {
    super(message, options)
    this.name = "ConfigurationError"
    this.code = options.code ?? "invalid_value"
    if (options.path !== undefined) this.path = options.path
    if (options.range !== undefined) this.range = options.range
    if (options.keyPath !== undefined) this.keyPath = options.keyPath
  }
}
