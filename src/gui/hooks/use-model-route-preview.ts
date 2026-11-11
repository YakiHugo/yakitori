import { useEffect, useState } from "react"
import type { ModelSelection } from "../../protocol/events.ts"
import type {
  ModelRoutePreview,
  ModelRoutePreviewRequest,
  ModelRouteRequirements,
} from "../../protocol/model-routing.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import { useAppStore } from "../store/app-store.ts"

export function useModelRoutePreview(
  selection: ModelSelection | undefined,
  requirements: ModelRouteRequirements = {},
  sessionId?: string,
  contextRevision?: number,
) {
  const apiBase = useAppStore((state) => state.apiBase)
  const providers = useAppStore((state) => state.providers)
  // Session-scoped preview reads stored history. Keying it on every durable
  // seq retriggers that read for each replayed event and stalls session load.
  // Wait until hydration finishes, then refresh once per completed turn.
  const sessionReady = useAppStore(
    (state) =>
      sessionId === undefined || state.hydratingSessionId !== sessionId,
  )
  const turnEpoch = useAppStore((state) => {
    if (
      sessionId === undefined ||
      state.selection.sessionId !== sessionId ||
      state.hydratingSessionId === sessionId
    )
      return undefined
    let last: string | undefined
    for (const [turnId, timing] of Object.entries(
      state.execution.turnTimings,
    )) {
      if (timing.completedAt !== undefined) last = turnId
    }
    return last
  })
  const key =
    selection === undefined || !sessionReady
      ? undefined
      : JSON.stringify([
          {
            selection,
            requirements,
            ...(sessionId === undefined ? {} : { sessionId }),
          },
          contextRevision ?? turnEpoch,
        ])
  const [result, setResult] =
    useState<
      Readonly<{
        key: string
        directory: typeof providers
        preview?: ModelRoutePreview
        error?: string
      }>
    >()
  useEffect(() => {
    if (key === undefined) return
    let active = true
    void getAppRpcClient(apiBase)
      .request(
        "model/preview",
        (JSON.parse(key) as [ModelRoutePreviewRequest])[0],
      )
      .then(
        (preview) => {
          if (active) setResult({ key, directory: providers, preview })
        },
        (error: unknown) => {
          if (active)
            setResult({
              key,
              directory: providers,
              error:
                error instanceof Error
                  ? error.message
                  : "Model availability could not be checked.",
            })
        },
      )
    return () => {
      active = false
    }
  }, [apiBase, key, providers])
  return result !== undefined &&
    result.key === key &&
    result.directory === providers
    ? result
    : undefined
}
