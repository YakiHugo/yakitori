import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import type { InstructionProfileId } from "./model-catalog.ts"

export type InstructionProfile = {
  readonly id: InstructionProfileId
  readonly revision: string
  readonly text: string
}

const instructionProfileUrls: Record<InstructionProfileId, URL> = {
  anthropic: new URL("./prompts/anthropic.md", import.meta.url),
  codex: new URL("./prompts/codex.md", import.meta.url),
  default: new URL("./prompts/default.md", import.meta.url),
  grok: new URL("./prompts/grok.md", import.meta.url),
  kimi: new URL("./prompts/kimi.md", import.meta.url),
}

const instructionProfiles = new Map<InstructionProfileId, InstructionProfile>()

export function getInstructionProfile(
  id: InstructionProfileId,
): InstructionProfile {
  const existing = instructionProfiles.get(id)
  if (existing) return existing
  const url = instructionProfileUrls[id]
  if (!url) throw new Error(`Instruction profile ${id} is not registered.`)
  const text = readFileSync(url, "utf8").trim()
  const profile = {
    id,
    revision: createHash("sha256").update(text).digest("hex"),
    text,
  }
  instructionProfiles.set(id, profile)
  return profile
}
