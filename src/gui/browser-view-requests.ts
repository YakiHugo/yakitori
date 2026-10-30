import type {
  WorkspaceBrowserBridge,
  WorkspaceBrowserShowRequest,
} from "../desktop/workspace-browser-types.ts"
import { useAppStore } from "./store/app-store.ts"
import {
  selectWorkspacePresentation,
  useWorkspaceStore,
} from "./store/workspace-store.ts"

export function connectBrowserViewRequests(
  bridge: Pick<
    WorkspaceBrowserBridge,
    "onShowRequest" | "claimShow" | "completeShow"
  >,
): () => void {
  let mounted = true
  const handle = async (request: WorkspaceBrowserShowRequest) => {
    const eligible = () => {
      const workspace = useWorkspaceStore.getState()
      return (
        mounted &&
        useAppStore.getState().settingsSection === undefined &&
        workspace.sessionId === request.ownerSessionId &&
        workspace.tabs.some(
          (tab) =>
            tab.id === request.tabId &&
            tab.kind === "browser" &&
            tab.workspaceSessionId === request.ownerSessionId,
        )
      )
    }
    if (!eligible()) {
      await bridge.completeShow({
        requestId: request.requestId,
        result: "refused",
      })
      return
    }
    let claimed = false
    try {
      claimed = await bridge.claimShow({ requestId: request.requestId })
      if (!claimed) return
      // Session changes and component unmounts can happen during the claim IPC.
      if (!eligible()) {
        await bridge.completeShow({
          requestId: request.requestId,
          result: "refused",
        })
        return
      }
      useWorkspaceStore.getState().activate(request.tabId)
      const presentation = selectWorkspacePresentation(
        useWorkspaceStore.getState(),
      )
      if (!presentation.open || presentation.activeId !== request.tabId)
        throw new Error(
          "The claimed browser tab was not selected in its workspace.",
        )
      await bridge.completeShow({
        requestId: request.requestId,
        result: "applied",
      })
    } catch (cause) {
      if (claimed) {
        try {
          await bridge.completeShow({
            requestId: request.requestId,
            result: "failed",
          })
        } catch (cleanup) {
          throw new AggregateError(
            [cause, cleanup],
            "Browser display and acknowledgement failed.",
          )
        }
      }
      throw cause
    }
  }
  const unsubscribe = bridge.onShowRequest((request) => {
    void handle(request).catch((cause) => {
      queueMicrotask(() => {
        throw cause
      })
    })
  })
  return () => {
    mounted = false
    unsubscribe()
  }
}
