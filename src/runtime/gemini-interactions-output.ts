import { isDeepStrictEqual } from "node:util"
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "../kernel/index.ts"
import {
  GeminiIncompleteStreamError,
  GeminiProtocolError,
} from "./gemini-transport.ts"
import {
  type ModelContentBlock,
  type ModelRequest,
  type ModelResponse,
  ModelStopReason,
  type ModelStreamEvent,
  type ModelUsage,
} from "./model.ts"
import {
  modelNativeItems,
  modelNativeResponseMetadata,
} from "./model-native.ts"

type StreamStep = {
  value: Record<string, JsonValue>
  closed: boolean
  arguments?: string
  partIndex?: number
}

export class GeminiInteractionFailedError extends Error {
  status: string

  constructor(status: string) {
    super(`Gemini Interactions ended with status ${status}.`)
    this.status = status
  }
}

// Decode the current step-based protocol, not the historical content.* stream.
// A step.stop closes JSON, but only a terminal interaction + valid EOF commits
// calls. This prevents a truncated/failed parallel batch from running tools.
// https://ai.google.dev/static/api/interactions.openapi.json
export function createGeminiInteractionOutput(
  request: ModelRequest,
  itemId: string,
) {
  const steps: StreamStep[] = []
  let metadata: JsonObject = {}
  let status: string | undefined
  let terminal = false
  let done = false
  let usage: ModelUsage | undefined
  const customKeys = new Map(
    request.tools.flatMap((tool) =>
      tool.kind === "custom" && tool.customInputFallbackKey !== undefined
        ? [[tool.name, tool.customInputFallbackKey] as const]
        : [],
    ),
  )
  return {
    get usage() {
      return usage
    },
    get responseId() {
      return typeof metadata.id === "string" ? metadata.id : undefined
    },
    accept(payload: unknown): ModelStreamEvent[] {
      if (payload === "[DONE]") {
        if (done || !terminal)
          throw new GeminiIncompleteStreamError(
            "Interactions stream ended before a terminal status.",
          )
        done = true
        return []
      }
      if (!isJsonObject(payload) || typeof payload.event_type !== "string")
        throw new GeminiProtocolError("Invalid Interactions event.")
      const interaction = isJsonObject(payload.interaction)
        ? payload.interaction
        : undefined
      const sample =
        interaction?.usage ??
        payload.usage ??
        (isJsonObject(payload.metadata)
          ? payload.metadata.total_usage
          : undefined)
      if (!terminal && sample !== undefined) {
        usage = interactionUsage(sample)
        request.onUsageSnapshot?.(usage)
      }
      if (request.signal?.aborted) return []
      if (done || terminal)
        throw new GeminiProtocolError(
          "Interactions returned data after completion.",
        )
      if (
        payload.event_type === "interaction.created" ||
        payload.event_type === "interaction.completed"
      ) {
        if (
          interaction === undefined ||
          typeof interaction.id !== "string" ||
          !interaction.id ||
          typeof interaction.status !== "string"
        )
          throw new GeminiProtocolError("Invalid Interactions lifecycle event.")
        if (metadata.id !== undefined && metadata.id !== interaction.id)
          throw new GeminiProtocolError(
            "Interactions response identity changed.",
          )
        if (
          status !== undefined &&
          status !== "in_progress" &&
          status !== interaction.status
        )
          throw new GeminiProtocolError("Interactions terminal status changed.")
        if (
          payload.event_type === "interaction.created" &&
          (metadata.id !== undefined ||
            steps.length > 0 ||
            interaction.status !== "in_progress")
        )
          throw new GeminiProtocolError(
            "Unexpected Interactions creation event.",
          )
        if (interaction.steps !== undefined) {
          if (
            !Array.isArray(interaction.steps) ||
            !interaction.steps.every(isJsonObject)
          )
            throw new GeminiProtocolError(
              "Invalid terminal Interactions steps.",
            )
          if (steps.length === 0) {
            for (const value of interaction.steps)
              steps.push({ value, closed: true })
          } else if (
            !isDeepStrictEqual(
              interaction.steps,
              steps.map((step) => completedStep(step)),
            )
          )
            throw new GeminiProtocolError(
              "Terminal Interactions steps disagree with the stream.",
            )
        }
        const { steps: _steps, ...envelope } = interaction
        metadata = { ...metadata, ...envelope }
        status = interaction.status
        terminal = payload.event_type === "interaction.completed"
        if (terminal && status === "in_progress")
          throw new GeminiProtocolError(
            "Completed Interactions event is still in progress.",
          )
        return []
      }
      if (payload.event_type === "interaction.status_update") {
        if (
          typeof payload.interaction_id !== "string" ||
          typeof payload.status !== "string" ||
          (metadata.id !== undefined &&
            metadata.id !== payload.interaction_id) ||
          (status !== undefined && status !== "in_progress")
        )
          throw new GeminiProtocolError("Invalid Interactions status update.")
        status = payload.status
        metadata = {
          ...metadata,
          id: payload.interaction_id,
          status,
          ...(payload.continuation_token === undefined
            ? {}
            : { continuation_token: payload.continuation_token }),
        }
        return []
      }
      if (status !== undefined && status !== "in_progress")
        throw new GeminiProtocolError(
          "Interactions emitted a step after its terminal status.",
        )
      const index = payload.index
      if (
        typeof index !== "number" ||
        !Number.isSafeInteger(index) ||
        index < 0
      )
        throw new GeminiProtocolError("Invalid Interactions step index.")
      if (payload.event_type === "step.start") {
        if (
          index !== steps.length ||
          !isJsonObject(payload.step) ||
          typeof payload.step.type !== "string"
        )
          throw new GeminiProtocolError(
            "Invalid or duplicate Interactions step start.",
          )
        const value = structuredClone(payload.step)
        if (
          ![
            "model_output",
            "thought",
            "function_call",
            ...hostedSteps,
          ].includes(value.type as string)
        )
          throw new GeminiProtocolError(
            `Unsupported Interactions step: ${value.type}.`,
          )
        const partIndex = steps.filter(
          (step) => step.value.type === value.type,
        ).length
        steps.push({ value, closed: false, partIndex })
        return []
      }
      const step = steps[index]
      if (step === undefined || step.closed)
        throw new GeminiProtocolError(
          "Interactions step is missing or already closed.",
        )
      if (payload.event_type === "step.stop") {
        step.closed = true
        return []
      }
      if (payload.event_type !== "step.delta" || !isJsonObject(payload.delta))
        throw new GeminiProtocolError(
          `Unsupported Interactions event: ${payload.event_type}.`,
        )
      const delta = payload.delta
      const value = step.value
      if (value.type === "function_call" && delta.type === "arguments_delta") {
        if (typeof delta.arguments !== "string")
          throw new GeminiProtocolError("Invalid function argument delta.")
        step.arguments = (step.arguments ?? "") + delta.arguments
        return []
      }
      if (value.type === "thought" && delta.type === "thought_signature") {
        if (typeof delta.signature !== "string")
          throw new GeminiProtocolError("Invalid thought signature.")
        value.signature = String(value.signature ?? "") + delta.signature
        return []
      }
      if (value.type === "thought" && delta.type === "thought_summary") {
        if (
          !isJsonObject(delta.content) ||
          delta.content.type !== "text" ||
          typeof delta.content.text !== "string"
        )
          throw new GeminiProtocolError(
            "Unsupported Interactions thought summary.",
          )
        value.summary = [...contentArray(value.summary), delta.content]
        return [
          {
            type: "reasoning_delta",
            text: delta.content.text,
            representation: "summary",
            partIndex: step.partIndex ?? 0,
            ...(request.streamOutputItems ? { itemId } : {}),
          },
        ]
      }
      if (
        value.type === "model_output" &&
        (delta.type === "text" || delta.type === "text_annotation_delta")
      ) {
        const content = contentArray(value.content)
        let part = content.at(-1)
        if (part === undefined) {
          part = { type: "text", text: "" }
          content.push(part)
        }
        if (part.type !== "text" || typeof part.text !== "string")
          throw new GeminiProtocolError(
            "Unsupported Interactions output content.",
          )
        value.content = content
        if (delta.type === "text_annotation_delta") {
          if (!Array.isArray(delta.annotations))
            throw new GeminiProtocolError("Invalid Interactions annotations.")
          part.annotations = [
            ...(Array.isArray(part.annotations) ? part.annotations : []),
            ...delta.annotations,
          ]
          return []
        }
        if (typeof delta.text !== "string")
          throw new GeminiProtocolError("Invalid Interactions text delta.")
        part.text += delta.text
        return [
          {
            type: "delta",
            text: delta.text,
            partIndex: step.partIndex ?? 0,
            ...(request.streamOutputItems ? { itemId } : {}),
          },
        ]
      }
      if (
        hostedSteps.includes(String(value.type)) &&
        delta.type === value.type
      ) {
        // Hosted steps are provider data, never authority to execute local tools.
        mergeHostedDelta(value, delta)
        return []
      }
      throw new GeminiProtocolError(
        `Unsupported Interactions delta: ${delta.type}.`,
      )
    },
    finish(): ModelResponse {
      if (!terminal || status === undefined || status === "in_progress")
        throw new GeminiIncompleteStreamError(
          "Interactions stream ended without completion.",
        )
      if (status === "failed" || status === "cancelled")
        throw new GeminiInteractionFailedError(status)
      if (
        status !== "completed" &&
        status !== "requires_action" &&
        status !== "incomplete"
      )
        throw new GeminiProtocolError(
          `Interactions ended with status ${status}.`,
        )
      const incomplete = status === "incomplete"
      if (!incomplete && steps.some((step) => !step.closed))
        throw new GeminiIncompleteStreamError(
          "Interactions ended with an open step.",
        )
      let incompleteToolCalls = false
      const content: ModelContentBlock[] = []
      const native: JsonObject[] = []
      const callIds = new Set<string>()
      for (const step of steps) {
        if (step.value.type === "function_call" && incomplete) {
          incompleteToolCalls = true
          continue
        }
        // Unclosed opaque thoughts are not safe continuation material.
        if (step.value.type === "thought" && !step.closed) continue
        const value = completedStep(step)
        if (value.type === "model_output" || value.type === "thought") {
          const parts = contentArray(
            value.type === "thought" ? value.summary : value.content,
          )
          if (
            parts.some(
              (part) => part.type !== "text" || typeof part.text !== "string",
            )
          )
            throw new GeminiProtocolError(
              "Unsupported Interactions generated content.",
            )
          if (value.type === "thought") {
            if (
              value.signature !== undefined &&
              typeof value.signature !== "string"
            )
              throw new GeminiProtocolError(
                "Invalid Interactions thought signature.",
              )
            content.push({
              type: "reasoning",
              text: parts.map((part) => part.text).join(""),
              representation: "summary",
            })
          } else
            content.push({
              type: "text",
              text: parts.map((part) => part.text).join(""),
            })
        } else if (value.type === "function_call") {
          if (
            typeof value.id !== "string" ||
            !value.id ||
            callIds.has(value.id) ||
            typeof value.name !== "string" ||
            !value.name ||
            !isJsonObject(value.arguments)
          )
            throw new GeminiProtocolError(
              "Invalid or duplicate Interactions function call.",
            )
          callIds.add(value.id)
          const key = customKeys.get(value.name)
          const args = value.arguments
          if (key !== undefined && typeof args[key] !== "string")
            throw new GeminiProtocolError("Invalid custom function input.")
          content.push({
            type: "tool_call",
            id: value.id,
            name: value.name,
            input: key === undefined ? args : (args[key] as string),
            ...(key === undefined
              ? {}
              : { toolKind: "custom", customInputFallbackKey: key }),
          })
        } else if (!hostedSteps.includes(String(value.type)))
          throw new GeminiProtocolError(
            `Unsupported Interactions output: ${value.type}.`,
          )
        native.push(value)
      }
      if (status === "requires_action" && callIds.size === 0)
        throw new GeminiProtocolError(
          "Interactions requires action without a function call.",
        )
      return {
        stopReason: incomplete
          ? ModelStopReason.Length
          : callIds.size > 0
            ? ModelStopReason.ToolUse
            : ModelStopReason.EndTurn,
        rawStopReason: status,
        content,
        native: modelNativeItems(request, "gemini_interactions", native),
        nativeMetadata: modelNativeResponseMetadata(
          request,
          "gemini_interactions",
          metadata,
        ),
        ...(typeof metadata.id === "string"
          ? { providerResponseId: metadata.id }
          : {}),
        ...(usage === undefined ? {} : { usage }),
        ...(incomplete ? { lengthReason: "output" } : {}),
        ...(incompleteToolCalls ? { incompleteToolCalls: true } : {}),
      }
    },
  }
}

function mergeHostedDelta(
  value: Record<string, JsonValue>,
  delta: JsonObject,
): void {
  for (const [key, next] of Object.entries(delta)) {
    const previous = value[key]
    if (key === "name" || key === "server_name") {
      if (
        typeof next !== "string" ||
        (previous !== undefined && previous !== "" && previous !== next)
      )
        throw new GeminiProtocolError("Hosted tool identity changed.")
      value[key] = next
    } else if (key === "arguments" && isJsonObject(next)) {
      const args = isJsonObject(previous) ? previous : {}
      const merged = { ...args, ...next }
      // These are typed deltas, not JSON patches: code streams as text and
      // retrieval arguments stream as lists. MCP's arbitrary JSON stays opaque.
      if (value.type === "code_execution_call") {
        if (next.code !== undefined) {
          if (
            typeof next.code !== "string" ||
            (args.code !== undefined && typeof args.code !== "string")
          )
            throw new GeminiProtocolError("Invalid hosted code delta.")
          merged.code = (args.code ?? "") + next.code
        }
        if (
          next.language !== undefined &&
          args.language !== undefined &&
          args.language !== next.language
        )
          throw new GeminiProtocolError("Hosted code language changed.")
      } else {
        const listKey =
          value.type === "url_context_call"
            ? "urls"
            : value.type === "google_search_call" ||
                value.type === "google_maps_call"
              ? "queries"
              : undefined
        if (listKey !== undefined && next[listKey] !== undefined) {
          const before = args[listKey] ?? []
          const after = next[listKey]
          if (!Array.isArray(before) || !Array.isArray(after))
            throw new GeminiProtocolError("Invalid hosted retrieval delta.")
          merged[listKey] = [...before, ...after]
        }
      }
      value.arguments = merged
    } else if (key === "result" || key === "signature") {
      value[key] =
        Array.isArray(previous) && Array.isArray(next)
          ? [...previous, ...next]
          : typeof previous === "string" && typeof next === "string"
            ? previous + next
            : isJsonObject(previous) && isJsonObject(next)
              ? { ...previous, ...next }
              : next
    } else value[key] = next
  }
}

function contentArray(value: unknown): Record<string, JsonValue>[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every(isJsonObject))
    throw new GeminiProtocolError("Invalid Interactions content array.")
  return value
}

function completedStep(step: StreamStep): JsonObject {
  if (step.arguments === undefined) return step.value
  const args: unknown = JSON.parse(step.arguments)
  if (!isJsonObject(args))
    throw new GeminiProtocolError("Function arguments must be an object.")
  return { ...step.value, arguments: args }
}

function interactionUsage(value: unknown): ModelUsage {
  if (!isJsonObject(value))
    throw new GeminiProtocolError("Invalid Interactions usage.")
  const counts = [
    "total_input_tokens",
    "total_output_tokens",
    "total_thought_tokens",
    "total_tokens",
    "total_cached_tokens",
  ] as const
  for (const key of counts)
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "number" ||
        !Number.isSafeInteger(value[key]) ||
        value[key] < 0)
    )
      throw new GeminiProtocolError("Invalid Interactions token count.")
  const input = value.total_input_tokens as number | undefined
  const output = value.total_output_tokens as number | undefined
  const thoughts = value.total_thought_tokens as number | undefined
  const total = value.total_tokens as number | undefined
  const cached = value.total_cached_tokens as number | undefined
  return {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined && thoughts === undefined
      ? {}
      : { outputTokens: (output ?? 0) + (thoughts ?? 0) }),
    ...(total === undefined ? {} : { activeContextTokens: total }),
    ...(cached === undefined ? {} : { cacheReadInputTokens: cached }),
  }
}

const hostedSteps = [
  "google_search_call",
  "google_search_result",
  "url_context_call",
  "url_context_result",
  "file_search_call",
  "file_search_result",
  "code_execution_call",
  "code_execution_result",
  "google_maps_call",
  "google_maps_result",
  "mcp_server_tool_call",
  "mcp_server_tool_result",
]
