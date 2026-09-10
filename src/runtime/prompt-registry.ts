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
