import { useCallback, useEffect, useState } from "react"
import type { GitStatusResponse } from "../../protocol/workspace.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import { useAppStore } from "../store/app-store.ts"

export function useWorkspaceGitStatus({
  cwd,
  apiBase,
  active = true,
}: Readonly<{
  cwd: string | undefined
  apiBase: string
  active?: boolean
}>): {
  status: GitStatusResponse | undefined
  loading: boolean
  error: string | undefined
  refresh(): void
  revision: number
} {
  const activeTurnId = useAppStore((state) => state.execution.activeTurnId)
  const [requestRevision, setRequestRevision] = useState(0)
  const [snapshot, setSnapshot] = useState<{
    cwd: string | undefined
    apiBase: string
    status?: GitStatusResponse | undefined
    loading: boolean
    error?: string
    revision: number
  }>({ cwd, apiBase, loading: false, revision: 0 })
  const refresh = useCallback(
    () => setRequestRevision((value) => value + 1),
    [],
  )

  // Each effect owns one request. Cleanup prevents older reads from replacing
  // a newer snapshot, including when the same directory is reopened.
  // biome-ignore lint/correctness/useExhaustiveDependencies: turn boundaries and explicit refreshes invalidate the snapshot.
  useEffect(() => {
    if (!active || !cwd) return
    let current = true
    setSnapshot((previous) => ({
      cwd,
      apiBase,
      status:
        previous.cwd === cwd && previous.apiBase === apiBase
          ? previous.status
          : undefined,
      loading: true,
      revision: previous.revision,
    }))
    void getAppRpcClient(apiBase)
      .request("git/status", { cwd })
      .then(
        (status) => {
          if (!current) return
          setSnapshot((previous) => ({
            cwd,
            apiBase,
            status,
            loading: false,
            revision: previous.revision + 1,
          }))
        },
        (cause: unknown) => {
          if (!current) return
          setSnapshot((previous) => ({
            ...previous,
            loading: false,
            error:
              cause instanceof Error
                ? cause.message
                : "Could not load changes.",
          }))
        },
      )
    return () => {
      current = false
    }
  }, [active, apiBase, cwd, activeTurnId, requestRevision])

  useEffect(() => {
    if (!active || !cwd) return
    window.addEventListener("focus", refresh)
    window.addEventListener("yakitori:workspace-file-saved", refresh)
    window.addEventListener("yakitori:workspace-git-changed", refresh)
    return () => {
      window.removeEventListener("focus", refresh)
      window.removeEventListener("yakitori:workspace-file-saved", refresh)
      window.removeEventListener("yakitori:workspace-git-changed", refresh)
    }
  }, [active, cwd, refresh])

  const sameScope = snapshot.cwd === cwd && snapshot.apiBase === apiBase
  return {
    status: sameScope ? snapshot.status : undefined,
    loading:
      active &&
      Boolean(cwd) &&
      (!sameScope || snapshot.loading || (!snapshot.status && !snapshot.error)),
    error: sameScope ? snapshot.error : undefined,
    refresh,
    revision: snapshot.revision,
  }
}
