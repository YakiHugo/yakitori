import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import type { PromptId } from "./model-catalog.ts"

export type PromptDefinition = {
  readonly id: PromptId
  readonly revision: string
  readonly text: string
}

const promptUrls: Record<PromptId, URL> = {
  anthropic: new URL("./prompts/anthropic.md", import.meta.url),
  default: new URL("./prompts/default.md", import.meta.url),
  gpt: new URL("./prompts/gpt.md", import.meta.url),
  kimi: new URL("./prompts/kimi.md", import.meta.url),
}

const prompts = new Map<PromptId, PromptDefinition>()

export function getPrompt(id: PromptId): PromptDefinition {
  const existing = prompts.get(id)
  if (existing) return existing
  const url = promptUrls[id]
  if (!url) throw new Error(`Prompt ${id} is not registered.`)
  const text = readPrompt(url).trim()
  const prompt = {
    id,
    revision: createHash("sha256").update(text).digest("hex"),
    text,
  }
  prompts.set(id, prompt)
  return prompt
}

function readPrompt(url: URL): string {
  if (url.protocol === "file:") return readFileSync(url, "utf8")
  if (url.protocol !== "data:") {
    throw new Error(`Unsupported prompt URL protocol: ${url.protocol}`)
  }
  const separator = url.href.indexOf(",")
  if (separator < 0) throw new Error("Invalid prompt data URL.")
  const metadata = url.href.slice(0, separator)
  const data = url.href.slice(separator + 1)
  return metadata.endsWith(";base64")
    ? Buffer.from(data, "base64").toString("utf8")
    : decodeURIComponent(data)
}
