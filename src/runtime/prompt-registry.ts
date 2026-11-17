import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import instructionManifest from "./prompts/manifest.json" with { type: "json" }
import type { InstructionProfileId, ResolvedModel } from "./model-catalog.ts"

export type InstructionProfile = Readonly<{
  id: InstructionProfileId
  revision: string
  text: string
}>

const instructionProfiles = new Map<InstructionProfileId, InstructionProfile>()

export function getInstructionProfile(
  id: InstructionProfileId,
): InstructionProfile {
  const existing = instructionProfiles.get(id)
  if (existing) return existing
  const entry = instructionManifest[id]
  if (!entry) throw new Error(`Instruction profile ${id} is not registered.`)
  const text = readFileSync(
    new URL(`./prompts/${entry.file}`, import.meta.url),
    "utf8",
  ).trim()
  const profile = {
    id,
    revision: createHash("sha256").update(text).digest("hex"),
    text,
  }
  instructionProfiles.set(id, profile)
  return profile
}

export function getModelInstructions(model: ResolvedModel): InstructionProfile {
  if (model.instructions === undefined)
    return getInstructionProfile(model.instructionProfileId)
  return {
    id: model.instructionProfileId,
    revision: createHash("sha256").update(model.instructions).digest("hex"),
    text: model.instructions,
  }
}

export function getDelegationInstructions(
  model: ResolvedModel,
  effort: string | undefined,
): string {
  const reset =
    "Earlier model-specific delegation instructions no longer apply. Follow the current policy below; user requests take precedence."
  const overrides = model.delegationInstructions
  const codex =
    overrides !== undefined ||
    instructionManifest[model.instructionProfileId].agent === "codex" ||
    model.provider.toLowerCase() === "codex"
  // Codex ee344ca94583 (2026-11-15), session/multi_agents.rs:
  // catalog hint > effort-specific catalog text > bundled mode. Older Codex
  // profiles use the same explicit-request default as Yakitori host policy.
  let policy = overrides?.hint
  if (policy === undefined && effort === "ultra") {
    policy = overrides?.proactive
    if (policy === undefined && codex)
      policy =
        "Proactive multi-agent delegation is active. Delegate concrete, independent subtasks when doing so could save time or improve quality."
  } else if (policy === undefined) {
    policy = overrides?.explicit
    if (policy === undefined && codex)
      policy =
        "Spawn sub-agents only when the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents, delegation, or parallel agent work. Requests for thoroughness, research, investigation, or detailed analysis alone do not request delegation. Otherwise complete the work locally without asking for permission to delegate."
  }
  return `${reset}\n${policy ?? "You may delegate concrete, bounded subtasks that can run independently alongside useful local work. Keep tightly coupled work local."}`
}
