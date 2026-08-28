import type { TokenUsage } from "../kernel/index.ts"
import { isAbortError } from "./errors.ts"
import {
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  ModelStopReason,
  type ModelSystemSection,
  type ModelTarget,
  type ModelTextBlock,
  type StreamFn,
} from "./model.ts"
import { estimateModelRequestBudget } from "./model-request-budget.ts"

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

const TWO_PASS_MAX_INTERMEDIATE_CHARS = 12_000

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

export async function runTwoPassCompaction(input: {
  readonly source: readonly { readonly messages: readonly ModelMessage[] }[]
  readonly target: ModelTarget
  readonly baseInstructions: ModelSystemSection
  readonly cacheKey?: string
  readonly capacityTokens?: number
  readonly signal?: AbortSignal
  readonly compact: (request: ModelRequest) => Promise<CompactionResult>
}): Promise<CompactionResult | undefined> {
  const splitIndex = twoPassSplitIndex(input)
  if (splitIndex === undefined) return undefined
  const first = await input.compact(
    buildCompactionRequest({
      source: input.source.slice(0, splitIndex),
      target: input.target,
      baseInstructions: input.baseInstructions,
      ...(input.cacheKey === undefined ? {} : { cacheKey: input.cacheKey }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }),
  )
  const intermediate = intermediateCheckpoint(first.summary)
  const carrier = {
    messages: [
      {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: `<intermediate_compaction>\n${intermediate}\n</intermediate_compaction>`,
          },
        ],
      },
    ],
  }
  const secondRequest = buildCompactionRequest({
    source: [carrier, ...input.source.slice(splitIndex)],
    target: input.target,
    baseInstructions: input.baseInstructions,
    ...(input.cacheKey === undefined ? {} : { cacheKey: input.cacheKey }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    instruction: twoPassFinalInstruction(),
  })
  if (
    input.capacityTokens !== undefined &&
    estimateModelRequestBudget(secondRequest).requiredContextTokens >
      input.capacityTokens
  ) {
    throw new Error("Compaction context length exceeds the maximum context.")
  }
  const second = await input.compact(secondRequest)
  return {
    summary: second.summary,
    ...aggregateCompactionUsage(first.usage, second.usage),
  }
}

export function buildCompactionRequest(input: {
  readonly source: readonly { readonly messages: readonly ModelMessage[] }[]
  readonly target: ModelTarget
  readonly baseInstructions: ModelSystemSection
  readonly cacheKey?: string
  readonly instruction?: string
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
        content: [
          {
            type: "text",
            text: input.instruction ?? compactionInstruction(),
          },
        ],
      },
    ],
    tools: [],
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  }
}

// Compaction is housekeeping: the summary stream is drained locally because
// clients learn progress from the context_compaction item lifecycle, not from
// text snapshots. Fail loudly so the caller can fall back to dropped history.
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

function intermediateCheckpoint(summary: string): string {
  if (summary.length <= TWO_PASS_MAX_INTERMEDIATE_CHARS) return summary
  const marker = "\n[NOTE_1 truncated at the intermediate checkpoint limit]"
  return `${summary.slice(0, TWO_PASS_MAX_INTERMEDIATE_CHARS - marker.length)}${marker}`
}

function twoPassFinalInstruction(): string {
  return "Write the final self-contained checkpoint now. The preceding <intermediate_compaction> message is NOTE_1, the compressed record of the complete earlier prefix; the messages after it are the untouched later tail. Merge both into one checkpoint using the required sections. Preserve every material fact, user correction, decision, file path, error, and next step from NOTE_1; do not omit the earlier prefix merely because it is compressed. If NOTE_1 contains a truncation marker, record that limitation explicitly."
}

function twoPassSplitIndex(input: {
  readonly source: readonly { readonly messages: readonly ModelMessage[] }[]
  readonly target: ModelTarget
  readonly baseInstructions: ModelSystemSection
  readonly cacheKey?: string
  readonly capacityTokens?: number
  readonly signal?: AbortSignal
}): number | undefined {
  const { source } = input
  if (source.length < 2) return undefined
  if (input.capacityTokens !== undefined) {
    for (let splitIndex = source.length - 1; splitIndex >= 1; splitIndex -= 1) {
      const request = buildCompactionRequest({
        source: source.slice(0, splitIndex),
        target: input.target,
        baseInstructions: input.baseInstructions,
        ...(input.cacheKey === undefined ? {} : { cacheKey: input.cacheKey }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      if (
        estimateModelRequestBudget(request).requiredContextTokens <=
        input.capacityTokens
      ) {
        return splitIndex
      }
    }
    return undefined
  }
  const weights = source.map((group) =>
    Buffer.byteLength(JSON.stringify(group.messages), "utf8"),
  )
  const target = weights.reduce((total, weight) => total + weight, 0) * 0.95
  let accumulated = 0
  for (const [index, weight] of weights.entries()) {
    accumulated += weight
    if (accumulated >= target) {
      return Math.min(Math.max(index + 1, 1), source.length - 1)
    }
  }
  return source.length - 1
}

function aggregateCompactionUsage(
  first: TokenUsage | undefined,
  second: TokenUsage | undefined,
): { readonly usage?: TokenUsage } {
  if (first === undefined && second === undefined) return {}
  return {
    usage: {
      inputTokens: (first?.inputTokens ?? 0) + (second?.inputTokens ?? 0),
      outputTokens: (first?.outputTokens ?? 0) + (second?.outputTokens ?? 0),
      ...sumOptionalUsage(
        "cacheReadInputTokens",
        first?.cacheReadInputTokens,
        second?.cacheReadInputTokens,
      ),
      ...sumOptionalUsage(
        "cacheWriteInputTokens",
        first?.cacheWriteInputTokens,
        second?.cacheWriteInputTokens,
      ),
    },
  }
}

function sumOptionalUsage<
  Key extends "cacheReadInputTokens" | "cacheWriteInputTokens",
>(
  key: Key,
  first: number | undefined,
  second: number | undefined,
): Partial<Record<Key, number>> {
  return first === undefined && second === undefined
    ? {}
    : ({ [key]: (first ?? 0) + (second ?? 0) } as Partial<Record<Key, number>>)
}

function createAbortError(): Error {
  const error = new Error("Compaction was aborted.")
  error.name = "AbortError"
  return error
}
