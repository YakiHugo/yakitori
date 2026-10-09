export type AcpEngineConfiguration = Readonly<{
  id: string
  label: string
  command: string
  args?: readonly string[]
}>

// Configuration names an already-installed executable. No package installation,
// credential discovery or shell command interpolation takes place here.
export function readAcpEngineConfiguration(
  value: unknown,
): readonly AcpEngineConfiguration[] {
  if (value === undefined) return []
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value
  if (!Array.isArray(parsed)) throw new Error("ACP engines must be an array.")
  const ids = new Set(["yakitori"])
  return parsed.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      throw new Error("Each ACP engine must be a configuration object.")
    const config = entry as Record<string, unknown>
    for (const key of Object.keys(config))
      if (!["id", "label", "command", "args"].includes(key))
        throw new Error(`Unknown ACP engine configuration field: ${key}`)
    const { id, label, command, args } = config
    if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id))
      throw new Error("ACP engine id must be a nonempty identifier.")
    if (ids.has(id)) throw new Error(`Duplicate or reserved engine id: ${id}`)
    ids.add(id)
    if (typeof label !== "string" || !label.trim())
      throw new Error("ACP engine label must be a nonempty string.")
    if (
      typeof command !== "string" ||
      !command.trim() ||
      command.includes("\0")
    )
      throw new Error("ACP engine command must name an executable.")
    if (
      args !== undefined &&
      (!Array.isArray(args) ||
        args.some(
          (arg: unknown) => typeof arg !== "string" || arg.includes("\0"),
        ))
    )
      throw new Error("ACP engine args must be an array of strings.")
    return {
      id,
      label,
      command,
      ...(args === undefined ? {} : { args: args as string[] }),
    }
  })
}
