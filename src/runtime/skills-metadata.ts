import { parseDocument } from "yaml"
import type { InstructionDiagnostic } from "./instruction-files.ts"

export type SkillToolDependency = Readonly<{
  type: string
  value: string
  description?: string
  transport?: string
  command?: string
  url?: string
  oauthCallbackPort?: number
}>

export type SkillInvocationMetadata = Readonly<{
  policy?: Readonly<{ allowImplicitInvocation?: boolean }>
  dependencies?: Readonly<{ tools: readonly SkillToolDependency[] }>
}>

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Optional Codex metadata fails open: report malformed fields without hiding
// the SKILL.md workflow. This parser never executes dependency commands.
export function parseSkillInvocationMetadata(
  path: string,
  text: string,
): { metadata: SkillInvocationMetadata; diagnostics: InstructionDiagnostic[] } {
  const diagnostics: InstructionDiagnostic[] = []
  const warn = (message: string) => diagnostics.push({ path, message })
  const document = parseDocument(text)
  if (document.errors.length) {
    warn(`Ignoring invalid skill metadata: ${document.errors[0]?.message}`)
    return { metadata: {}, diagnostics }
  }
  let value: unknown
  try {
    value = document.toJS({ maxAliasCount: 100 })
  } catch (error) {
    if (!(error instanceof ReferenceError)) throw error
    warn(`Ignoring invalid skill metadata: ${error.message}`)
    return { metadata: {}, diagnostics }
  }
  if (!record(value)) {
    warn("Skill metadata must be a YAML mapping.")
    return { metadata: {}, diagnostics }
  }
  let policy: SkillInvocationMetadata["policy"]
  if (value.policy !== undefined) {
    if (
      !record(value.policy) ||
      (value.policy.allow_implicit_invocation !== undefined &&
        typeof value.policy.allow_implicit_invocation !== "boolean")
    ) {
      warn("policy.allow_implicit_invocation must be a boolean.")
    } else if (typeof value.policy.allow_implicit_invocation === "boolean") {
      policy = {
        allowImplicitInvocation: value.policy.allow_implicit_invocation,
      }
    }
  }
  const tools: SkillToolDependency[] = []
  if (value.dependencies !== undefined) {
    if (
      !record(value.dependencies) ||
      (value.dependencies.tools !== undefined &&
        !Array.isArray(value.dependencies.tools))
    ) {
      warn("dependencies.tools must be a list.")
    } else {
      for (const entry of value.dependencies.tools ?? []) {
        if (!record(entry)) {
          warn("Each skill dependency must be a mapping.")
          continue
        }
        const string = (field: string, required = false) => {
          const raw = entry[field]
          if (raw === undefined && !required) return undefined
          if (typeof raw !== "string" || !raw.trim()) {
            warn(`dependencies.tools.${field} must be a nonempty string.`)
            return undefined
          }
          return raw.replace(/\s+/g, " ").trim()
        }
        const type = string("type", true)
        const dependencyValue = string("value", true)
        if (!type || !dependencyValue) continue
        const dependency: SkillToolDependency = {
          type,
          value: dependencyValue,
          ...Object.fromEntries(
            ["description", "transport", "command", "url"]
              .map((field) => [field, string(field)])
              .filter(([, value]) => value !== undefined),
          ),
        }
        const oauth = entry.oauth
        if (oauth !== undefined) {
          const port = record(oauth)
            ? (oauth.callbackPort ?? oauth.callback_port)
            : undefined
          if (
            typeof port === "number" &&
            Number.isInteger(port) &&
            port >= 0 &&
            port <= 65535
          ) {
            tools.push({ ...dependency, oauthCallbackPort: port })
            continue
          }
          if (!record(oauth) || port !== undefined)
            warn("dependencies.tools.oauth.callbackPort must be a valid port.")
        }
        tools.push(dependency)
      }
    }
  }
  return {
    metadata: {
      ...(policy === undefined ? {} : { policy }),
      ...(tools.length ? { dependencies: { tools } } : {}),
    },
    diagnostics,
  }
}

export type SkillMcpServer = Readonly<{
  name: string
  url?: string
  available: boolean
  reason?: string
}>

export type SkillDependencyDiagnostic = Readonly<{
  skillName: string
  skillPath: string
  dependency: SkillToolDependency
  status: "missing" | "unavailable"
  message: string
}>

export function getSkillDependencyDiagnostics(
  skills: readonly (SkillInvocationMetadata &
    Readonly<{ name: string; path: string; enabled?: boolean }>)[],
  mcpServers: readonly SkillMcpServer[],
): SkillDependencyDiagnostic[] {
  return skills
    .filter((skill) => skill.enabled !== false)
    .flatMap((skill) =>
      (skill.dependencies?.tools ?? []).flatMap((dependency) => {
        if (dependency.type !== "mcp") return []
        const servers = mcpServers.filter(
          (server) =>
            server.name === dependency.value ||
            (dependency.url !== undefined && server.url === dependency.url),
        )
        if (servers.some((server) => server.available)) return []
        const status = servers.length ? "unavailable" : "missing"
        const reason = servers.find((server) => server.reason)?.reason
        return [
          {
            skillName: skill.name,
            skillPath: skill.path,
            dependency,
            status,
            message: `Skill ${skill.name} requires MCP server ${dependency.value}, which is ${status}${reason ? ` (${reason})` : ""}. Ask the user to configure or enable this dependency before using its tools.${dependency.url ? ` Declared server URL: ${dependency.url}.` : ""}`,
          } satisfies SkillDependencyDiagnostic,
        ]
      }),
    )
}
