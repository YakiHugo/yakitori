import { isJsonObject } from "../kernel/index.ts"
import type {
  ModelAssistantMessage,
  ModelContentBlock,
  ModelNativeItem,
  ModelRequest,
} from "./model.ts"

type NativeWireApi = ModelNativeItem["wireApi"]

// Unlike Codex's single Responses protocol, Yakitori must fence opaque replay
// by API, credentials and model. Native values are data, never proof that the
// harness has executed a tool or permission decision.
export function modelNativeItems(
  request: Pick<ModelRequest, "target" | "continuationScope">,
  wireApi: NativeWireApi,
  values: readonly unknown[],
): ModelNativeItem[] {
  return values.map((value) => {
    const json: unknown = JSON.parse(JSON.stringify(value))
    if (!isJsonObject(json)) throw new Error("Invalid native model item.")
    return {
      provider: request.target.provider,
      model: request.target.model,
      wireApi,
      ...(request.continuationScope === undefined
        ? {}
        : { scope: request.continuationScope }),
      value: json,
    }
  })
}

export function replayModelNativeItems(
  message: ModelAssistantMessage,
  wireApi: NativeWireApi,
  provider: string,
  scope?: string,
  model?: string,
): ModelNativeItem["value"][] | undefined {
  if (message.native === undefined || message.native.length === 0)
    return undefined
  if (
    scope === undefined ||
    model === undefined ||
    !message.native.every(
      (item) =>
        item.provider === provider &&
        item.wireApi === wireApi &&
        item.scope === scope &&
        item.model === model,
    )
  )
    return undefined
  // Request builders may add cache breakpoints. Those request-only controls
  // must not mutate the durable native response retained for later replay.
  return message.native.map((item) => structuredClone(item.value))
}

// Output bodies live in native items. The response envelope separately retains
// usage detail, safety/grounding data, model versions and provider extensions.
export function modelNativeResponseMetadata(
  request: Parameters<typeof modelNativeItems>[0],
  wireApi: NativeWireApi,
  metadata: unknown,
): ModelNativeItem {
  const [native] = modelNativeItems(request, wireApi, [metadata])
  if (native === undefined) throw new Error("Missing native response metadata.")
  return native
}

// If native replay was declined, its projected metadata cannot reintroduce the
// same opaque state through a second, less strict path.
export function portableModelContent(
  message: ModelAssistantMessage,
): readonly ModelContentBlock[] {
  if (message.native === undefined) return message.content
  return message.content.map((block) => {
    if (!("providerMetadata" in block)) return block
    const { providerMetadata: _metadata, ...portable } = block
    return portable
  })
}
