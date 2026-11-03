import type { ProviderPreset } from "../protocol/providers.ts"
import { glmTextModel } from "./glm-models.ts"
import { isLongCatEndpoint } from "./longcat-vision.ts"
import { isMimoEndpoint } from "./mimo-image-policy.ts"
import { isRekaEndpoint } from "./reka-vision.ts"
import { isSenseNovaEndpoint } from "./sensenova-vision.ts"
import { isSparkChatEndpoint } from "./spark-chat-policy.ts"
import { isStepfunEndpoint } from "./stepfun-image-policy.ts"

type Flavor = NonNullable<ProviderPreset["flavor"]>
type RequestEndpoint = Readonly<{ baseURL: string; model: string }>
type RequestDialect = Readonly<{
  matches(endpoint: RequestEndpoint): boolean
  maxOutputTokensField: "max_tokens" | "max_completion_tokens"
}>

// These endpoints report streaming usage without OpenAI stream_options. This
// table selects field names only; admission and native-history rules stay with
// their protocol owners. A flavor on a relay does not select a native dialect.
const requestDialects: Partial<Record<Flavor, RequestDialect>> = {
  stepfun: {
    matches: ({ baseURL }) => isStepfunEndpoint(baseURL),
    maxOutputTokensField: "max_tokens",
  },
  mimo: {
    matches: ({ baseURL }) => isMimoEndpoint(baseURL),
    maxOutputTokensField: "max_completion_tokens",
  },
  sensenova: {
    matches: ({ baseURL }) => isSenseNovaEndpoint(baseURL),
    maxOutputTokensField: "max_tokens",
  },
  longcat: {
    matches: ({ baseURL }) => isLongCatEndpoint(baseURL),
    maxOutputTokensField: "max_tokens",
  },
  reka: {
    matches: ({ baseURL }) => isRekaEndpoint(baseURL),
    maxOutputTokensField: "max_tokens",
  },
  spark: {
    matches: ({ baseURL }) => isSparkChatEndpoint(baseURL),
    maxOutputTokensField: "max_completion_tokens",
  },
  glm: {
    matches: ({ baseURL, model }) =>
      isGlmStandardEndpoint(baseURL) && glmTextModel(model) !== undefined,
    maxOutputTokensField: "max_tokens",
  },
}

export function isGlmStandardEndpoint(baseURL: string): boolean {
  return (
    URL.parse(baseURL)?.href.replace(/\/$/, "") ===
    "https://api.z.ai/api/paas/v4"
  )
}

export function chatCompletionsRequestFields(
  endpoint: RequestEndpoint & Readonly<{ flavor: Flavor | undefined }>,
  maxOutputTokens: number | undefined,
): {
  stream_options?: { include_usage: true }
  max_tokens?: number
  max_completion_tokens?: number
} {
  const configured = requestDialects[endpoint.flavor ?? "generic"]
  const dialect = configured?.matches(endpoint) ? configured : undefined
  return {
    ...(dialect === undefined
      ? { stream_options: { include_usage: true as const } }
      : {}),
    ...(maxOutputTokens === undefined
      ? {}
      : { [dialect?.maxOutputTokensField ?? "max_tokens"]: maxOutputTokens }),
  }
}

// Serialization uses the caller's existing scoped flavor. Chat-only services
// omit detail for user images; preserve the separate tool-media contract rather
// than broadening it when consolidating the two serialization paths.
const omittedImageDetail: Partial<
  Record<Flavor, readonly ("user" | "tool")[]>
> = {
  qwen: ["user", "tool"],
  glm: ["user", "tool"],
  sensenova: ["user"],
  longcat: ["user"],
  tencent: ["user", "tool"],
  reka: ["user", "tool"],
  mimo: ["user", "tool"],
}

export function chatCompletionsImageFields(
  flavor: Flavor,
  source: "user" | "tool",
): { detail?: "high" } {
  return omittedImageDetail[flavor]?.includes(source) ? {} : { detail: "high" }
}
