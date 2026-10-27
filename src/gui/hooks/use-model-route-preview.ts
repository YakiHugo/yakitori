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
  const sessionRevision = useAppStore((state) =>
    state.selectedSession?.id === sessionId &&
    state.selectedSession?.activeTurnId === undefined
      ? state.selectedSession?.seq
      : undefined,
  )
  const key =
    selection === undefined
      ? undefined
      : JSON.stringify([
          {
            selection,
            requirements,
            ...(sessionId === undefined ? {} : { sessionId }),
          },
          contextRevision ?? sessionRevision,
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
