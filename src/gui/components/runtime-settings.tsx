import { useEffect, useRef, useState } from "react"
import type { ConfigurationSnapshot } from "../../protocol/configuration.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import { createSettingsWriter } from "../lib/settings-writer.ts"
import { useAppStore } from "../store/app-store.ts"
import { Button } from "./ui/button.tsx"

export function RuntimeSettings() {
  const apiBase = useAppStore((state) => state.apiBase)
  const cwd = useAppStore((state) => state.selectedSession?.workingDirectory)
  return (
    <RuntimeConfiguration
      key={`${apiBase}:${cwd ?? ""}`}
      apiBase={apiBase}
      cwd={cwd}
    />
  )
}

function RuntimeConfiguration({
  apiBase,
  cwd,
}: Readonly<{ apiBase: string; cwd: string | undefined }>) {
  const [configuration, setConfiguration] = useState<ConfigurationSnapshot>()
  const [enabled, setEnabled] = useState(false)
  const [error, setError] = useState<string>()
  const [writeState, setWriteState] = useState<{
    pending: boolean
    error?: string
  }>({ pending: false })
  const snapshot = useRef<ConfigurationSnapshot | undefined>(undefined)
  const mounted = useRef(true)
  const [revision, setRevision] = useState(0)
  const [writer] = useState(() =>
    createSettingsWriter<boolean>({
      async write(value) {
        const user = snapshot.current?.layers.find(
          (layer) => layer.source === "user",
        )
        if (!user) throw new Error("User configuration file is unavailable.")
        const response = await getAppRpcClient(apiBase).request(
          "config/write",
          {
            keyPath: ["agents", "expose_model_overrides"],
            value,
            expectedVersion: user.version,
            ...(cwd === undefined ? {} : { cwd }),
          },
        )
        snapshot.current = response
        if (mounted.current) setConfiguration(response)
      },
      changed(state) {
        if (mounted.current) {
          setWriteState(state)
          if (!state.pending && !state.error && snapshot.current)
            setEnabled(
              snapshot.current.configuration.agents?.exposeModelOverrides ??
                false,
            )
        } else if (state.error) useAppStore.setState({ message: state.error })
      },
    }),
  )
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (!writer.failed()) void writer.flush()
    }
  }, [writer])
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry requests a fresh configuration snapshot.
  useEffect(() => {
    let current = true
    void getAppRpcClient(apiBase)
      .request("config/read", cwd === undefined ? {} : { cwd })
      .then(
        (response) => {
          if (!current) return
          snapshot.current = response
          setConfiguration(response)
          setEnabled(
            response.configuration.agents?.exposeModelOverrides ?? false,
          )
          setError(undefined)
        },
        (cause: unknown) => {
          if (current)
            setError(
              cause instanceof Error
                ? cause.message
                : "Could not load runtime settings.",
            )
        },
      )
    return () => {
      current = false
    }
  }, [apiBase, cwd, revision])
  if (!configuration)
    return error ? (
      <>
        <p role="alert">{error}</p>
        <Button type="button" onClick={() => setRevision((value) => value + 1)}>
          Retry
        </Button>
      </>
    ) : (
      <p role="status">Loading runtime settings…</p>
    )
  const origin = configuration.origins["agents.expose_model_overrides"]
  const projectOverride = origin?.source === "project"
  return (
    <>
      <div className="settings-group">
        <div className="settings-row">
          <div>
            <h4>Subagent model selection</h4>
            <p id="subagent-model-selection-description">
              Let the agent choose a model across connected providers and its
              reasoning effort for subagents. When off, subagents inherit the
              parent’s model and reasoning effort.
            </p>
          </div>
          <input
            type="checkbox"
            role="switch"
            aria-label="Subagent model selection"
            aria-describedby="subagent-model-selection-description"
            aria-checked={enabled}
            className="settings-switch"
            checked={enabled}
            disabled={projectOverride}
            onChange={(event) => {
              setEnabled(event.target.checked)
              writer.update(event.target.checked)
            }}
          />
        </div>
      </div>
      <p className="settings-hint">
        {projectOverride
          ? `This project overrides the setting in ${origin.path}. Edit that file to change it.`
          : "Saved to your user configuration. Changes apply at the next agent step."}
      </p>
      {writeState.pending ? (
        <p role="status" className="mt-3 text-xs text-muted-foreground">
          Applying changes…
        </p>
      ) : null}
      {writeState.error ? (
        <div className="mt-3">
          <p role="alert" className="text-sm text-destructive">
            {writeState.error}
          </p>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              void getAppRpcClient(apiBase)
                .request("config/read", cwd === undefined ? {} : { cwd })
                .then(
                  (response) => {
                    snapshot.current = response
                    void writer.flush()
                  },
                  (cause: unknown) => {
                    if (mounted.current)
                      setWriteState({
                        pending: false,
                        error:
                          cause instanceof Error
                            ? cause.message
                            : "Could not load runtime settings.",
                      })
                  },
                )
            }}
          >
            Retry changes
          </Button>
        </div>
      ) : null}
    </>
  )
}
