import { realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { parseDocument } from "yaml"
import {
  type InstructionDiagnostic,
  instructionDirectories,
  instructionHome,
  isFileSystemError,
  readInstructionPrefix,
  utf8Prefix,
} from "./instruction-files.ts"
import { discoverSkillFiles, mapSkillFiles } from "./skills-discovery.ts"
import {
  getSkillDependencyDiagnostics,
  parseSkillInvocationMetadata,
  type SkillInvocationMetadata,
  type SkillMcpServer,
} from "./skills-metadata.ts"

export {
  getSkillDependencyDiagnostics,
  type SkillDependencyDiagnostic,
  type SkillMcpServer,
  type SkillToolDependency,
} from "./skills-metadata.ts"

export const SKILLS_CATALOG_MAX_BYTES = 20 * 1024
// Host safety boundaries: bound metadata I/O, traversal memory, and injected
// text independently. Large bodies do not remove a skill from discovery.
const METADATA_READ_BYTES = 32 * 1024
const BODY_READ_BYTES = 256 * 1024
// Common shell variables are not skill mentions, matching Codex selection.
const commonEnvironmentVariables = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "PWD",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "TERM",
  "XDG_CONFIG_HOME",
])
export type SkillConfiguration = Readonly<{
  paths?: readonly string[]
  config?: readonly Readonly<{
    name?: string
    path?: string
    enabled: boolean
  }>[]
}>
type SkillDefinition = Readonly<{
  name: string
  description: string
  path: string
}>
export type SkillMetadata = SkillDefinition &
  SkillInvocationMetadata &
  Readonly<{
    scope: "user" | "repo"
    enabled?: boolean
  }>
export type SkillsCatalog = Readonly<{
  skills: readonly SkillMetadata[]
  text: string
  truncated: boolean
}>
export type SkillsSnapshot = Readonly<{
  skills: readonly SkillMetadata[]
  diagnostics: readonly InstructionDiagnostic[]
}>
export type SkillLoadInput = Readonly<{
  workspaceRoot?: string
  workingDirectory: string
  homeDir?: string
  userHomeDir?: string
  maxBytes?: number
  projectRootMarkers?: readonly string[]
  configuration?: SkillConfiguration
}>

const usage = `## Skills
A skill is a workflow in a SKILL.md file. User instructions take precedence over skill instructions.
When the user names a skill with $name or plain text, use it for that turn. Otherwise use a skill only when its description clearly matches the task. Do not carry skill activation across turns automatically.
Before taking task actions, read the selected SKILL.md completely; continue truncated or paginated reads until EOF. A skill body already supplied with this input need not be read again unless incomplete.
Resolve relative references from the skill directory. Follow its references routing and read required instruction files yourself before acting; load only relevant references. Reuse supplied scripts, assets, and templates.
For multiple skills, choose the smallest sufficient set and announce the order. Report missing, disabled, ambiguous, or unreadable skills; do not claim they were loaded. Continue with an appropriate fallback when possible.
`

export function createSkillsLoader(): (
  input: SkillLoadInput,
) => Promise<SkillsSnapshot> {
  // Each invocation owns its inventory and parsed metadata. Sharing mutable
  // stat-keyed caches lets concurrent refreshes publish stale mixed snapshots.
  return async (input) => {
    const directories = await instructionDirectories(
      input.workingDirectory,
      input.projectRootMarkers,
      input.workspaceRoot,
    )
    const roots = [
      ...directories.map((path) => ({
        path: join(path, ".agents", "skills"),
        scope: "repo" as const,
      })),
      {
        path: join(input.homeDir ?? instructionHome(), "skills"),
        scope: "user" as const,
      },
      // Codex host_roots: the shared user catalog lives in ~/.agents/skills.
      {
        path: join(input.userHomeDir ?? homedir(), ".agents", "skills"),
        scope: "user" as const,
      },
      ...(input.configuration?.paths ?? []).map((path) => ({
        path,
        scope: "user" as const,
      })),
    ]
    const diagnostics: InstructionDiagnostic[] = []
    const rules = await mapSkillFiles(
      input.configuration?.config ?? [],
      async (rule) => {
        if (rule.path === undefined) return rule
        try {
          return { ...rule, path: await realpath(rule.path) }
        } catch (error) {
          if (!isFileSystemError(error)) throw error
          return rule
        }
      },
    )
    const skills = new Map<string, SkillMetadata>()
    const candidates = new Map<string, SkillMetadata["scope"]>()
    for (const root of roots) {
      const discovery = await discoverSkillFiles(root.path)
      diagnostics.push(...discovery.diagnostics)
      for (const path of discovery.paths)
        if (!candidates.has(path)) candidates.set(path, root.scope)
    }
    const loaded = await mapSkillFiles(
      [...candidates],
      async ([candidate, scope]) => {
        const warnings: InstructionDiagnostic[] = []
        try {
          const path = await realpath(candidate)
          const prefix = await readInstructionPrefix(path, METADATA_READ_BYTES)
          const skill = parseSkillMetadata(path, prefix.text)
          if ("message" in skill) {
            return { warnings: [skill] }
          }
          let metadata: SkillInvocationMetadata = {}
          const metadataPath = join(dirname(path), "agents", "openai.yaml")
          try {
            const sidecar = await readInstructionPrefix(
              metadataPath,
              METADATA_READ_BYTES,
            )
            if (sidecar.truncated)
              warnings.push({
                path: metadataPath,
                message:
                  "Skill metadata exceeds the host read safety boundary.",
              })
            else {
              const parsed = parseSkillInvocationMetadata(
                metadataPath,
                sidecar.text,
              )
              metadata = parsed.metadata
              warnings.push(...parsed.diagnostics)
            }
          } catch (error) {
            if (!isFileSystemError(error)) throw error
            if (error.code !== "ENOENT")
              warnings.push({ path: metadataPath, message: error.message })
          }
          let enabled = true
          for (const rule of rules) {
            if (
              rule.path === path ||
              (rule.path === undefined && rule.name === skill.name)
            ) {
              enabled = rule.enabled
            }
          }
          return { skill: { ...skill, ...metadata, scope, enabled }, warnings }
        } catch (error) {
          if (!isFileSystemError(error)) throw error
          if (error.code !== "ENOENT")
            warnings.push({ path: candidate, message: error.message })
          return { warnings }
        }
      },
    )
    for (const result of loaded) {
      diagnostics.push(...result.warnings)
      if (result.skill && !skills.has(result.skill.path))
        skills.set(result.skill.path, result.skill)
    }
    return {
      skills: [...skills.values()].sort(
        (a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
      ),
      diagnostics,
    }
  }
}

function parseSkillMetadata(
  path: string,
  text: string,
): SkillDefinition | InstructionDiagnostic {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/.exec(text)
  if (match === null)
    return { path, message: "Missing or oversized YAML frontmatter." }
  const document = parseDocument(match[1] ?? "")
  const error = document.errors[0]
  if (error !== undefined) return { path, message: error.message }
  const nameValue: unknown = document.get("name")
  if (nameValue !== undefined && typeof nameValue !== "string") {
    return { path, message: "Skill name must be a string." }
  }
  const descriptionValue: unknown = document.get("description")
  if (typeof descriptionValue !== "string" || descriptionValue.trim() === "") {
    return { path, message: "Skill description must be a nonempty string." }
  }
  const name = nameValue?.replace(/\s+/g, " ").trim() || basename(dirname(path))
  const description = descriptionValue.replace(/\s+/g, " ").trim()
  return { name, description, path }
}

export function renderSkillsCatalog(
  snapshot: SkillsSnapshot,
  maxBytes = SKILLS_CATALOG_MAX_BYTES,
): SkillsCatalog | undefined {
  const skills = snapshot.skills.filter(
    (skill) =>
      skill.enabled !== false &&
      skill.policy?.allowImplicitInvocation !== false,
  )
  if (skills.length === 0 && snapshot.diagnostics.length === 0) return undefined
  const intro =
    usage +
    snapshot.diagnostics
      .map(
        (diagnostic) =>
          `Skill discovery warning at ${diagnostic.path}: ${diagnostic.message}\n`,
      )
      .join("")
  const line = (skill: SkillMetadata, length: number) =>
    `- ${skill.name}${length ? `: ${utf8Prefix(skill.description, length)}` : ""} (file: ${skill.path})\n`
  const render = (length: number) =>
    intro + skills.map((skill) => line(skill, length)).join("")
  const maxDescriptionBytes = Math.max(
    0,
    ...skills.map((skill) => Buffer.byteLength(skill.description)),
  )
  let text = render(maxDescriptionBytes)
  if (Buffer.byteLength(text) <= maxBytes)
    return { skills: snapshot.skills, text, truncated: false }
  let low = 0
  let high = maxDescriptionBytes
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(render(mid)) <= maxBytes) low = mid
    else high = mid - 1
  }
  text = render(low)
  if (Buffer.byteLength(text) > maxBytes) {
    const notice = "Additional skills omitted by catalog budget.\n"
    text = intro
    for (const skill of skills) {
      const row = line(skill, 0)
      if (Buffer.byteLength(text + row + notice) > maxBytes) break
      text += row
    }
    text = utf8Prefix(text + notice, maxBytes)
  }
  return { skills: snapshot.skills, text, truncated: true }
}

export async function loadSkillsCatalog(
  input: SkillLoadInput,
): Promise<SkillsCatalog | undefined> {
  return renderSkillsCatalog(await createSkillsLoader()(input), input.maxBytes)
}

export async function loadExplicitSkillInstructions(
  text: string,
  snapshot: SkillsSnapshot,
  onWarning?: (message: string) => void,
  options?: Readonly<{ mcpServers?: readonly SkillMcpServer[] }>,
): Promise<string | undefined> {
  const selected = new Map<string, SkillMetadata>()
  const diagnostics: string[] = []
  const paths = new Set(
    [...text.matchAll(/\[\$([^\]]+)\]\(([^)]+)\)/g)]
      .filter(
        (match) =>
          !commonEnvironmentVariables.has((match[1] ?? "").toUpperCase()),
      )
      .map((match) => match[2]),
  )
  for (const path of paths) {
    let canonical = path
    if (path !== undefined) {
      try {
        canonical = await realpath(path)
      } catch (error) {
        if (!isFileSystemError(error)) throw error
      }
    }
    const skill = snapshot.skills.find((skill) => skill.path === canonical)
    if (skill !== undefined && skill.enabled !== false)
      selected.set(skill.path, skill)
    else diagnostics.push(`Skill unavailable at ${path}.`)
  }
  // Path-qualified mentions are resolved first and must not activate a second
  // skill with the same name through the plain-name pass.
  const plain = text.replace(/\[\$[^\]]+\]\([^)]+\)/g, "")
  const names = new Set(
    [...plain.matchAll(/(?:^|[^\w$])\$([\p{L}\p{N}_-]+)(?![\w-])/gu)].map(
      (match) => match[1],
    ),
  )
  for (const name of names) {
    if (commonEnvironmentVariables.has((name ?? "").toUpperCase())) continue
    const matches = snapshot.skills.filter(
      (skill) => skill.name === name && skill.enabled !== false,
    )
    if (matches.length === 1 && matches[0])
      selected.set(matches[0].path, matches[0])
    else
      diagnostics.push(
        matches.length > 1
          ? `Skill $${name} is ambiguous; choose an explicit SKILL.md path: ${matches.map((skill) => skill.path).join(", ")}.`
          : `Skill $${name} is unavailable or disabled.`,
      )
  }
  const blocks: string[] = []
  if (options?.mcpServers !== undefined)
    diagnostics.push(
      ...getSkillDependencyDiagnostics(
        [...selected.values()],
        options.mcpServers,
      ).map((diagnostic) => diagnostic.message),
    )
  for (const skill of selected.values()) {
    try {
      const body = await readInstructionPrefix(skill.path, BODY_READ_BYTES)
      blocks.push(
        `<skill>\n<name>${skill.name}</name>\n<path>${skill.path}</path>\n${body.text}\n${body.truncated ? "Skill body reached the host injection safety boundary; read the remainder before acting.\n" : ""}</skill>`,
      )
    } catch (error) {
      if (!isFileSystemError(error)) throw error
      diagnostics.push(
        `Failed to load skill ${skill.name} at ${skill.path}: ${error.message}`,
      )
    }
  }
  for (const diagnostic of diagnostics) onWarning?.(diagnostic)
  if (diagnostics.length)
    blocks.push(
      `<skill_diagnostics>\n${diagnostics.join("\n")}\n</skill_diagnostics>`,
    )
  return blocks.length ? blocks.join("\n\n") : undefined
}
