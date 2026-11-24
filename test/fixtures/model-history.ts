import type { JsonObject } from "../../src/kernel/index.ts"
import type {
  ModelMessage,
  ModelOpaqueCheckpoint,
} from "../../src/runtime/model.ts"

export function opaqueCheckpoint(
  identity: Omit<ModelOpaqueCheckpoint["owner"], "wireApi">,
  encryptedContent: string,
  id = "cmp",
): ModelOpaqueCheckpoint {
  const owner = { ...identity, wireApi: "openai_responses" as const }
  const value: JsonObject = {
    type: "compaction",
    id,
    encrypted_content: encryptedContent,
  }
  return {
    role: "compaction",
    mode: "opaque",
    owner,
    estimatedTokens: 42,
    native: [{ ...owner, value }],
  }
}

export function messageContent(message: ModelMessage | undefined) {
  return message?.role === "compaction" ? undefined : message?.content
}
