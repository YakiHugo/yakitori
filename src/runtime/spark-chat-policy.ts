import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions"
import { isJsonObject } from "../kernel/index.ts"
import type { ModelRequest } from "./model.ts"
import { ModelRequestControlsError } from "./model-request-controls.ts"

export const sparkChatEndpoint = "https://maas-api.cn-huabei-1.xf-yun.com/v2"
export const sparkTextModel = "spark-x2.5"

export function isSparkChatEndpoint(baseURL: string): boolean {
  return URL.parse(baseURL)?.href.replace(/\/$/, "") === sparkChatEndpoint
}

// MaaS Chat contract checked 2026-11-03. AStudio's Lite display label has no
// confirmed public model ID; neither it nor hosted third-party models is mapped.
// https://maas.xfyun.cn/doc/guide/3、API%20接口/3.1%20星火模型%20API/3.1.1%20Chat.html
// https://maas.xfyun.cn/doc/guide/2、模型介绍/2.1%20星火模型.html
export function validateSparkChatRequest(
  request: ModelRequest,
  model: string,
): void {
  if (model !== sparkTextModel)
    throw new ModelRequestControlsError(
      "Spark MaaS currently adapts only spark-x2.5. AStudio display labels and other model IDs are not assumed compatible.",
    )
  if (
    request.parallelToolCalls !== undefined ||
    request.target.effort !== undefined ||
    request.target.speed !== undefined ||
    request.outputFormat !== undefined
  )
    throw new ModelRequestControlsError(
      "Spark MaaS Chat does not document parallel-tool, reasoning-effort, speed or structured-output overrides. Remove those overrides; the request was not sent.",
    )
  for (const message of request.messages) {
    if (message.role !== "user" && message.role !== "tool") continue
    if (message.content.some((block) => block.type !== "text"))
      throw new ModelRequestControlsError(
        "Spark-X2.5 accepts text only, including tool results. Images and PDFs were not read or sent.",
      )
  }
  if (
    request.tools.length > 128 ||
    request.tools.some(
      (tool) =>
        (tool.kind === "custom" && tool.customInputFallbackKey === undefined) ||
        tool.strict !== undefined ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name),
    )
  )
    throw new ModelRequestControlsError(
      "Spark MaaS accepts up to 128 function tools with 1–64 letter/digit/underscore/hyphen names. Native custom tools and strict overrides are not enabled; use a function fallback.",
    )
  const controls = request.providerOptions?.body ?? {}
  for (const key of Object.keys(controls)) {
    if (!["thinking", "temperature", "top_p"].includes(key))
      throw new ModelRequestControlsError(
        `Spark MaaS Chat does not enable the ${key} request control. Remove that override; the request was not sent.`,
      )
  }
  if (
    (controls.temperature !== undefined && controls.temperature !== 1) ||
    (controls.top_p !== undefined && controls.top_p !== 0.95)
  )
    throw new ModelRequestControlsError(
      "Spark MaaS fixes temperature at 1 and top_p at 0.95. Omit these controls or use their documented values.",
    )
  const thinking = controls.thinking
  if (
    thinking !== undefined &&
    (!isJsonObject(thinking) ||
      Object.keys(thinking).some((key) => key !== "type") ||
      !["enabled", "disabled", "auto"].includes(String(thinking.type)))
  )
    throw new ModelRequestControlsError(
      "Spark MaaS thinking accepts only type enabled, disabled or auto.",
    )
}

export function validateSparkChatMessages(
  messages: ChatCompletionMessageParam[],
): void {
  for (const message of messages) {
    // Native assistant envelopes bypass portable content conversion. Check them
    // too, without dropping opaque content or moving tool text into instructions.
    if (
      message.content != null &&
      typeof message.content !== "string" &&
      (!Array.isArray(message.content) ||
        message.content.some((part) => part.type !== "text"))
    )
      throw new ModelRequestControlsError(
        "Spark MaaS history supports text content only. Start a new conversation for incompatible native history; history has not been changed.",
      )
    if (
      message.role === "assistant" &&
      message.tool_calls?.some((call) => call.type !== "function")
    )
      throw new ModelRequestControlsError(
        "Spark MaaS history requires function tools, not native custom tools. Use a function fallback or start a new conversation; history has not been changed.",
      )
  }
}
