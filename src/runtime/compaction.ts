import type { TokenUsage } from "../kernel/index.ts"
import { isAbortError } from "./errors.ts"
import {
  ModelStopReason,
  type ModelRequest,
  type ModelMessage,
  type ModelResponse,
  type ModelSystemSection,
  type ModelTarget,
  type ModelTextBlock,
  type StreamFn,
} from "./model.ts"

export const COMPACTION_SYSTEM_PROMPT = `You are compressing a coding-agent conversation into a checkpoint for your future self. The earlier turns you see will be replaced by the checkpoint you write; the complete history remains on disk but will leave your context.

Write the checkpoint with exactly these sections, in this order:

Goal — what the user is trying to accomplish.
Progress — what is done so far, including key decisions and why they were made.
Files — exact paths read or modified, and why each one matters.
Errors — failures encountered and how they were resolved, or that they are still open.
User messages — every message the user sent, in order, as close to verbatim as possible. Corrections and rejections of earlier approaches matter most.
Next steps — the concrete work that remains, in order. When the conversation was interrupted mid-task, quote the immediate next action verbatim.

Rules:
- Use precise file paths, commands, and identifiers; avoid vague references.
- The checkpoint must be self-contained: it must make sense without the conversation it replaces.
- No pleasantries, preamble, or meta-commentary; output only the checkpoint.`

// Matches provider messages for an over-long request (Anthropic "prompt is
// too long", OpenAI "context_length_exceeded" style text, HTTP 413). Used to
// retry compaction with a smaller source instead of giving up.
export function isContextOverflowError(error: unknown): boolean {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase()
  return (
    message.includes("prompt is too long") ||
    message.includes("context length") ||
    message.includes("context_length") ||
    message.includes("maximum context") ||
    message.includes("too many tokens") ||
    message.includes("request too large") ||
    message.includes("413")
  )
}

export type CompactionResult = {
  readonly summary: string
  readonly usage?: TokenUsage
}

export function buildCompactionRequest(input: {
  readonly source: readonly { readonly messages: readonly ModelMessage[] }[]
  readonly target: ModelTarget
  readonly baseInstructions: ModelSystemSection
  readonly cacheKey?: string
  readonly signal?: AbortSignal
}): ModelRequest {
  return {
    target: input.target,
    ...(input.cacheKey === undefined ? {} : { cacheKey: input.cacheKey }),
    system: [
      input.baseInstructions,
      {
        id: "compaction.instructions",
        revision: "1",
        text: COMPACTION_SYSTEM_PROMPT,
      },
    ],
    messages: [
      ...input.source.flatMap((group) => group.messages),
      {
        role: "user",
        content: [{ type: "text", text: compactionInstruction() }],
      },
    ],
    tools: [],
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  }
}

// Compaction is housekeeping: drain the stream locally without publishing
// snapshots, and fail loudly so the caller can fall back to dropped history.
export async function runCompaction(input: {
  readonly stream: StreamFn
  readonly request: ModelRequest
}): Promise<CompactionResult> {
  let terminal: ModelResponse | undefined
  try {
    for await (const event of input.stream(input.request)) {
      if (event.type !== "response") continue
      if (terminal !== undefined) {
        throw new Error("Model stream emitted more than one terminal response.")
      }
      terminal = event.response
    }
  } catch (error) {
    if (isAbortError(error) || input.request.signal?.aborted) {
      throw createAbortError()
    }
    throw error
  }
  if (terminal === undefined) {
    throw new Error("Model stream ended without a terminal response.")
  }
  if (terminal.stopReason === ModelStopReason.Error) {
    throw new Error(terminal.error?.message ?? "Model returned an error.")
  }
  if (terminal.stopReason === ModelStopReason.Length) {
    throw new Error(
      "Compaction was truncated at the model output limit; checkpoint was not recorded.",
    )
  }
  if (
    terminal.stopReason === ModelStopReason.Aborted ||
    input.request.signal?.aborted
  ) {
    throw createAbortError()
  }
  const summary = terminal.content
    .filter((block): block is ModelTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim()
  if (summary.length === 0) {
    throw new Error("Compaction produced an empty checkpoint.")
  }
  return {
    summary,
    ...(terminal.usage === undefined
      ? {}
      : {
          usage: {
            inputTokens: terminal.usage.inputTokens ?? 0,
            outputTokens: terminal.usage.outputTokens ?? 0,
            ...(terminal.usage.cacheReadInputTokens === undefined
              ? {}
              : {
                  cacheReadInputTokens: terminal.usage.cacheReadInputTokens,
                }),
            ...(terminal.usage.cacheWriteInputTokens === undefined
              ? {}
              : {
                  cacheWriteInputTokens: terminal.usage.cacheWriteInputTokens,
                }),
          },
        }),
  }
}

function compactionInstruction(): string {
  return "Write the checkpoint for the conversation above now. If the conversation contains an earlier checkpoint, fold it into the new one; the new checkpoint must be self-contained and supersede it."
}

function createAbortError(): Error {
  const error = new Error("Compaction was aborted.")
  error.name = "AbortError"
  return error
}
