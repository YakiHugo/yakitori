import { useEffect, useRef, useState } from "react"
import type {
  ModelCatalogResponse,
  ProviderModelSettings,
} from "../../protocol/providers.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import { createSettingsWriter } from "../lib/settings-writer.ts"
import { useAppStore } from "../store/app-store.ts"
import { ProviderModels } from "./provider-models.tsx"
import { ModelConfigurationPanel } from "./model-configuration-panel.tsx"
import { Button } from "./ui/button.tsx"

export function ModelCatalogSettings({
  apiBase,
  provider,
}: Readonly<{ apiBase: string; provider: string }>) {
  return (
    <AccountModels
      key={`${apiBase}:${provider}`}
      apiBase={apiBase}
      provider={provider}
    />
  )
}

function AccountModels({
  apiBase,
  provider,
}: Readonly<{ apiBase: string; provider: string }>) {
  const [catalog, setCatalog] = useState<ModelCatalogResponse>()
  const [settings, setSettings] = useState<ProviderModelSettings>({})
  const [writeError, setWriteError] = useState<string>()
  const [error, setError] = useState<string>()
  const [revision, setRevision] = useState(0)
  const snapshot = useRef<ModelCatalogResponse | undefined>(undefined)
  const request = useRef(0)
  const readNeeded = useRef(false)
  const mounted = useRef(true)
  const page = useAppStore((state) => state.providerSettingsPage)
  const navigate = useAppStore((state) => state.setProviderSettingsPage)
  const editing =
    page.kind === "account"
      ? catalog?.models.find((model) => model.id === page.modelId)
      : undefined
  const editingKey = editing
    ? (Object.keys(settings).find(
        (id) => id.toLowerCase() === editing.id.toLowerCase(),
      ) ?? editing.id)
    : undefined
  const [writer] = useState(() =>
    createSettingsWriter<ProviderModelSettings>({
      async write(next) {
        if (!snapshot.current) throw new Error("Model settings are not loaded.")
        const response = await getAppRpcClient(apiBase).request(
          "provider/models/write",
          {
            provider,
            settings: next,
            version: snapshot.current.version,
          },
        )
        snapshot.current = response
        if (mounted.current) setCatalog(response)
        await useAppStore.getState().loadProviders()
      },
      changed(next) {
        if (mounted.current) {
          setWriteError(next.error)
          if (!next.pending && !next.error && readNeeded.current) {
            readNeeded.current = false
            setRevision((value) => value + 1)
          }
        } else if (next.error) useAppStore.setState({ message: next.error })
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
    const client = getAppRpcClient(apiBase)
    const load = () => {
      if (writer.pending() || writer.failed()) {
        readNeeded.current = true
        return
      }
      const id = ++request.current
      void client.request("provider/models/read", { provider }).then(
        (response) => {
          if (
            !mounted.current ||
            id !== request.current ||
            writer.pending() ||
            writer.failed()
          )
            return
          snapshot.current = response
          setCatalog(response)
          setSettings(response.settings)
          setError(undefined)
        },
        (cause: unknown) => {
          if (mounted.current && id === request.current)
            setError(
              cause instanceof Error ? cause.message : "Could not load models.",
            )
        },
      )
    }
    load()
    const unsubscribe = client.subscribeToProviderChanges(load)
    return () => {
      request.current++
      unsubscribe()
    }
  }, [apiBase, provider, revision, writer])
  if (!catalog)
    return (
      <div className="provider-loading">
        {error ? (
          <>
            <p role="alert">{error}</p>
            <Button
              type="button"
              onClick={() => setRevision((value) => value + 1)}
            >
              Retry
            </Button>
          </>
        ) : (
          <p>Loading models…</p>
        )}
      </div>
    )
  return (
    <>
      {catalog.error ? <p role="alert">{catalog.error}</p> : null}
      <ProviderModels
        configuration={{
          models: Object.entries(settings).map(([id, value]) => ({
            ...value,
            id,
          })),
        }}
        available={catalog.models}
        fetchingModels={false}
        onEditModel={(model) => {
          if (page.kind === "account") navigate({ ...page, modelId: model.id })
        }}
        onChange={(patch) => {
          request.current++
          const next = Object.fromEntries(
            patch.models.map(({ id, ...value }) => [id, value]),
          )
          setSettings(next)
          writer.update(next)
        }}
      />
      {editing && editingKey && page.kind === "account" ? (
        <ModelConfigurationPanel
          key={editing.id}
          apiBase={apiBase}
          provider={provider}
          model={editing}
          settings={settings[editingKey] ?? {}}
          onClose={() =>
            navigate({
              kind: "account",
              accountKind: page.accountKind,
              accountId: page.accountId,
            })
          }
          onChange={(override) => {
            request.current++
            const next = { ...settings, [editingKey]: override }
            setSettings(next)
            writer.update(next)
          }}
        />
      ) : null}
      {writeError ? (
        <div className="provider-message">
          <p role="alert">{writeError}</p>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              // Retrying explicitly reapplies the retained local edits to the current
              // configuration version after an operational failure or conflict.
              void getAppRpcClient(apiBase)
                .request("provider/models/read", { provider })
                .then(
                  (response) => {
                    snapshot.current = response
                    void writer.flush()
                  },
                  (cause: unknown) => {
                    if (mounted.current)
                      setWriteError(
                        cause instanceof Error
                          ? cause.message
                          : "Could not load models.",
                      )
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
