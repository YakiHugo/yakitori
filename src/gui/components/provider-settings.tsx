import { ArrowLeft, Plus } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type {
  ApiConfiguredProvider,
  ProviderConfiguration,
  ProviderConfigurationResponse,
  ProviderPreset,
  SubscriptionConnection,
} from "../../protocol/providers.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import { useAppStore } from "../store/app-store.ts"
import { ChatGPTConnections } from "./chatgpt-connections.tsx"
import { ChatGPTUsageLink } from "./chatgpt-usage-link.tsx"
import { ProviderCatalog } from "./provider-catalog.tsx"
import { ProviderConnectionList } from "./provider-connection-list.tsx"
import { type ProviderDraft, ProviderEditor } from "./provider-editor.tsx"
import { ProviderSubscription } from "./provider-subscription.tsx"
import { ProviderUsage } from "./provider-usage.tsx"
import { SidebarDialog } from "./sidebar-surfaces.tsx"
import { Button } from "./ui/button.tsx"
import "./provider-settings.css"

export function ProviderSettings() {
  const apiBase = useAppStore((state) => state.apiBase)
  const [view, setView] = useState<"providers" | "usage">("providers")
  return (
    <div className="provider-workspace">
      <header className="provider-workspace-header">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => useAppStore.getState().closeSettings()}
        >
          <ArrowLeft data-icon="inline-start" />
          Back to app
        </Button>
        <div
          className="provider-workspace-tabs"
          role="tablist"
          aria-label="Model sources"
        >
          {(["providers", "usage"] as const).map((tab) => (
            <button
              type="button"
              role="tab"
              key={tab}
              id={`provider-tab-${tab}`}
              aria-controls="provider-tab-content"
              aria-selected={view === tab}
              onClick={() => setView(tab)}
              onKeyDown={(event) => {
                if (
                  !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                    event.key,
                  )
                )
                  return
                event.preventDefault()
                const next =
                  event.key === "Home"
                    ? "providers"
                    : event.key === "End"
                      ? "usage"
                      : view === "providers"
                        ? "usage"
                        : "providers"
                setView(next)
                document.getElementById(`provider-tab-${next}`)?.focus()
              }}
            >
              {tab === "providers" ? "Providers" : "Usage"}
            </button>
          ))}
        </div>
      </header>
      <section
        className="provider-workspace-body"
        aria-label="Provider settings"
      >
        <div
          id="provider-tab-content"
          role="tabpanel"
          aria-labelledby={`provider-tab-${view}`}
        >
          <ProviderConnections key={apiBase} apiBase={apiBase} view={view} />
        </div>
      </section>
    </div>
  )
}

function ProviderConnections({
  apiBase,
  view,
}: Readonly<{ apiBase: string; view: "providers" | "usage" }>) {
  const loadProviders = useAppStore((state) => state.loadProviders)
  const [providers, setProviders] = useState<readonly ApiConfiguredProvider[]>()
  const [presets, setPresets] = useState<readonly ProviderPreset[]>([])
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<ProviderDraft>()
  const [pending, setPending] = useState<
    "save" | "test" | "delete" | "models"
  >()
  const [subscriptions, setSubscriptions] = useState<
    readonly SubscriptionConnection[]
  >([])
  const [subscriptionId, setSubscriptionId] = useState<string>()
  const [subscriptionStartLogin, setSubscriptionStartLogin] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importText, setImportText] = useState("")
  const [error, setError] = useState<string>()
  const [testStatus, setTestStatus] = useState<string>()
  const [undoId, setUndoId] = useState<string>()
  const [readRevision, setReadRevision] = useState(0)
  const mounted = useRef(true)
  const draftRevision = useRef(0)
  const pendingRequest = useRef<symbol | undefined>(undefined)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retrying a failed initial read invalidates its request.
  useEffect(() => {
    let current = true
    void getAppRpcClient(apiBase)
      .request("provider/configuration/read", {})
      .then(
        (response) => {
          if (!current) return
          setProviders(response.providers)
          setPresets(response.presets)
          setSubscriptions(response.subscriptions ?? [])
        },
        (cause: unknown) => {
          if (current)
            setError(
              cause instanceof Error
                ? cause.message
                : "Could not load provider connections.",
            )
        },
      )
    return () => {
      current = false
    }
  }, [apiBase, readRevision])

  const startAdding = (preset?: ProviderPreset) => {
    draftRevision.current++
    const configuration: ProviderConfiguration = preset
      ? {
          name: preset.name,
          wireApi: preset.wireApi,
          baseURL: preset.baseURL,
          ...(preset.envKey === undefined ? {} : { envKey: preset.envKey }),
          preset: preset.id,
          models: [],
          ...(preset.noKey ? { noKey: true } : {}),
        }
      : {
          name: "Custom provider",
          wireApi: "openai_chat_completions",
          baseURL: "",
          models: [],
        }
    setDraft({
      id: "",
      configuration,
      apiKey: "",
      existing: false,
    })
    setError(undefined)
    setTestStatus(undefined)
  }

  const changeDraft = (next: ProviderDraft) => {
    setDraft(next)
    setError(undefined)
    setTestStatus(undefined)
  }

  const perform = async (action: "save" | "test") => {
    if (draft === undefined) return
    const revision = draftRevision.current
    const request = Symbol()
    pendingRequest.current = request
    const { envKey, ...configured } = draft.configuration
    const normalizedEnvKey = envKey?.trim() || undefined
    const configuration: ProviderConfiguration = {
      ...configured,
      name: draft.configuration.name.trim(),
      baseURL: draft.configuration.baseURL.trim(),
      ...(normalizedEnvKey === undefined ? {} : { envKey: normalizedEnvKey }),
    }
    const params = {
      ...(draft.existing ? { id: draft.id } : {}),
      configuration,
      ...(draft.apiKey === "" ? {} : { apiKey: draft.apiKey }),
    }
    setPending(action)
    setError(undefined)
    setTestStatus(undefined)
    try {
      const client = getAppRpcClient(apiBase)
      if (action === "test") {
        await client.request("provider/configuration/test", params)
        if (
          mounted.current &&
          pendingRequest.current === request &&
          revision === draftRevision.current
        )
          setTestStatus("Connection test succeeded.")
      } else {
        const response = await client.request(
          "provider/configuration/write",
          params,
        )
        if (!mounted.current || pendingRequest.current !== request) return
        setProviders(response.providers)
        setPresets(response.presets)
        setSubscriptions(response.subscriptions ?? [])
        setUndoId(response.undoId)
        if (revision === draftRevision.current) {
          setDraft(undefined)
          setAdding(false)
        }
        await loadProviders()
      }
    } catch (cause) {
      if (
        mounted.current &&
        pendingRequest.current === request &&
        revision === draftRevision.current
      )
        setError(
          cause instanceof Error ? cause.message : "Provider action failed.",
        )
    } finally {
      if (mounted.current && pendingRequest.current === request) {
        pendingRequest.current = undefined
        setPending(undefined)
      }
    }
  }

  const remove = async (id: string) => {
    const revision = draftRevision.current
    const request = Symbol()
    pendingRequest.current = request
    setPending("delete")
    setError(undefined)
    try {
      const response = await getAppRpcClient(apiBase).request(
        "provider/configuration/delete",
        { id },
      )
      if (!mounted.current || pendingRequest.current !== request) return
      setProviders(response.providers)
      setPresets(response.presets)
      setSubscriptions(response.subscriptions ?? [])
      setUndoId(response.undoId)
      if (revision === draftRevision.current && draft?.id === id)
        setDraft(undefined)
      await loadProviders()
    } catch (cause) {
      if (
        mounted.current &&
        pendingRequest.current === request &&
        revision === draftRevision.current
      )
        setError(
          cause instanceof Error ? cause.message : "Could not remove provider.",
        )
    } finally {
      if (mounted.current && pendingRequest.current === request) {
        pendingRequest.current = undefined
        setPending(undefined)
      }
    }
  }

  const edit = (provider: ApiConfiguredProvider) => {
    draftRevision.current++
    setDraft({
      id: provider.id,
      configuration: provider.configuration,
      apiKey: "",
      existing: true,
    })
    setError(undefined)
    setTestStatus(undefined)
  }
  const changeConnection = async (
    action: () => Promise<ProviderConfigurationResponse>,
  ) => {
    const request = Symbol()
    pendingRequest.current = request
    setPending("save")
    setError(undefined)
    try {
      const response = await action()
      if (!mounted.current || pendingRequest.current !== request) return
      setProviders(response.providers)
      setSubscriptions(response.subscriptions ?? [])
      setPresets(response.presets)
      setUndoId(response.undoId)
      await loadProviders()
    } catch (cause) {
      if (mounted.current && pendingRequest.current === request)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not update the connection.",
        )
    } finally {
      if (mounted.current && pendingRequest.current === request) {
        pendingRequest.current = undefined
        setPending(undefined)
      }
    }
  }
  const closeEditor = () => {
    draftRevision.current++
    pendingRequest.current = undefined
    if (pending === "models") setPending(undefined)
    setDraft(undefined)
    setError(undefined)
    setTestStatus(undefined)
  }
  const closeImport = () => {
    pendingRequest.current = undefined
    setPending(undefined)
    setImporting(false)
    setError(undefined)
  }
  const hasConnections =
    (providers?.length ?? 0) > 0 ||
    subscriptions.some((entry) => entry.available)
  const showCatalog = providers !== undefined && (!hasConnections || adding)
  useEffect(
    () =>
      getAppRpcClient(apiBase).subscribeToProviderChanges(() =>
        setReadRevision((value) => value + 1),
      ),
    [apiBase],
  )
  useEffect(() => {
    if (!subscriptions.some((entry) => entry.login?.state === "running")) return
    const timer = setInterval(
      () => setReadRevision((value) => value + 1),
      1_000,
    )
    return () => clearInterval(timer)
  }, [subscriptions])
  const fetchModels = async () => {
    if (!draft) return
    const revision = draftRevision.current
    const request = Symbol()
    pendingRequest.current = request
    setPending("models")
    setError(undefined)
    try {
      const models = await getAppRpcClient(apiBase).request(
        "provider/configuration/models",
        {
          configuration: draft.configuration,
          ...(draft.existing ? { id: draft.id } : {}),
          ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
        },
      )
      if (
        mounted.current &&
        pendingRequest.current === request &&
        revision === draftRevision.current
      )
        setDraft({ ...draft, availableModels: models })
    } catch (cause) {
      if (
        mounted.current &&
        pendingRequest.current === request &&
        revision === draftRevision.current
      )
        setError(
          cause instanceof Error ? cause.message : "Could not fetch models.",
        )
    } finally {
      if (mounted.current && pendingRequest.current === request) {
        pendingRequest.current = undefined
        setPending(undefined)
      }
    }
  }
  const selectedPreset = presets.find(
    (preset) => preset.id === draft?.configuration.preset,
  )
  return (
    <>
      <div hidden={view !== "providers"}>
        <ChatGPTConnections apiBase={apiBase} active={view === "providers"} />
        {!showCatalog ? (
          <div className="provider-page-heading">
            <div>
              <h2>Providers</h2>
              <p>Connected models are available in every conversation.</p>
            </div>
            {hasConnections ? (
              <Button type="button" onClick={() => setAdding(true)}>
                <Plus data-icon="inline-start" />
                Add provider
              </Button>
            ) : null}
          </div>
        ) : null}
        {providers === undefined ? (
          <div className="provider-loading">
            <p>{error ? "Connections unavailable." : "Loading connections…"}</p>
            {error ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setError(undefined)
                  setReadRevision((revision) => revision + 1)
                }}
              >
                Retry
              </Button>
            ) : null}
          </div>
        ) : hasConnections && !adding ? (
          <ProviderConnectionList
            providers={providers}
            subscriptions={subscriptions}
            pending={pending !== undefined}
            onEdit={edit}
            onSubscription={(id) => {
              setSubscriptionStartLogin(false)
              setSubscriptionId(id)
            }}
            onEnabled={(provider, enabled) =>
              void changeConnection(() =>
                getAppRpcClient(apiBase).request(
                  "provider/configuration/write",
                  {
                    id: provider.id,
                    configuration: { ...provider.configuration, enabled },
                  },
                ),
              )
            }
            onMove={(id, beforeId) =>
              void changeConnection(() =>
                getAppRpcClient(apiBase).request(
                  "provider/configuration/move",
                  { id, ...(beforeId ? { beforeId } : {}) },
                ),
              )
            }
          />
        ) : null}
        {showCatalog ? (
          <ProviderCatalog
            presets={presets}
            providers={providers}
            subscriptions={subscriptions}
            onPick={(preset) => {
              const existing =
                preset &&
                providers.find(
                  (entry) => entry.configuration.preset === preset.id,
                )
              if (existing) edit(existing)
              else startAdding(preset)
            }}
            onSubscription={(entry) => {
              setSubscriptionStartLogin(true)
              setSubscriptionId(entry.id)
            }}
            {...(hasConnections ? { onClose: () => setAdding(false) } : {})}
            onImport={() => {
              setImporting(true)
              setError(undefined)
            }}
          />
        ) : null}
        {undoId ? (
          <div className="provider-undo" role="status">
            <span>Connection updated.</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending !== undefined}
              onClick={() =>
                void changeConnection(() =>
                  getAppRpcClient(apiBase).request(
                    "provider/configuration/restore",
                    { undoId },
                  ),
                )
              }
            >
              Undo
            </Button>
          </div>
        ) : null}
      </div>
      {view === "usage" ? (
        <>
          <div className="chatgpt-usage-summary">
            <strong>ChatGPT plan usage</strong>
            <ChatGPTUsageLink />
          </div>
          <ProviderUsage providers={providers ?? []} />
        </>
      ) : null}
      {subscriptions
        .filter((entry) => entry.id === subscriptionId)
        .map((entry) => (
          <ProviderSubscription
            key={entry.id}
            apiBase={apiBase}
            connection={entry}
            startLogin={subscriptionStartLogin}
            onChange={setSubscriptions}
            onConnected={() => {
              setAdding(false)
              setReadRevision((value) => value + 1)
              void loadProviders()
            }}
            onClose={() => setSubscriptionId(undefined)}
            onError={setError}
          />
        ))}
      {importing ? (
        <SidebarDialog title="Import provider" onClose={closeImport}>
          <p className="provider-field-hint">
            Paste a Yakitori provider connection as JSON: configuration plus an
            optional apiKey. Empty models fetch the service's catalog.
          </p>
          <textarea
            aria-label="Provider configuration JSON"
            className="provider-import-input"
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
            placeholder={
              '{"configuration":{"name":"My relay","wireApi":"openai_chat_completions","baseURL":"https://example.com/v1","models":[]},"apiKey":"…"}'
            }
          />
          {error ? <p role="alert">{error}</p> : null}
          <div className="provider-editor-footer">
            <Button type="button" variant="ghost" onClick={closeImport}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={pending !== undefined || !importText.trim()}
              onClick={() => {
                let value: unknown
                try {
                  value = JSON.parse(importText)
                } catch {
                  setError("Enter valid JSON.")
                  return
                }
                if (
                  !value ||
                  typeof value !== "object" ||
                  Array.isArray(value) ||
                  !("configuration" in value)
                ) {
                  setError("A connection must include configuration.")
                  return
                }
                const request = Symbol()
                pendingRequest.current = request
                setPending("save")
                setError(undefined)
                void getAppRpcClient(apiBase)
                  .request(
                    "provider/configuration/write",
                    value as {
                      configuration: ProviderConfiguration
                      apiKey?: string
                    },
                  )
                  .then(
                    (response) => {
                      if (
                        !mounted.current ||
                        pendingRequest.current !== request
                      )
                        return
                      setProviders(response.providers)
                      setUndoId(response.undoId)
                      setSubscriptions(response.subscriptions)
                      setImporting(false)
                      setImportText("")
                      setAdding(false)
                      void loadProviders()
                    },
                    (cause: unknown) => {
                      if (mounted.current && pendingRequest.current === request)
                        setError(
                          cause instanceof Error
                            ? cause.message
                            : "Import failed.",
                        )
                    },
                  )
                  .finally(() => {
                    if (mounted.current && pendingRequest.current === request) {
                      pendingRequest.current = undefined
                      setPending(undefined)
                    }
                  })
              }}
            >
              Import
            </Button>
          </div>
        </SidebarDialog>
      ) : null}
      {!draft && !importing && !subscriptionId && error ? (
        <p role="alert" className="provider-message text-destructive">
          {error}
        </p>
      ) : null}
      {draft ? (
        <ProviderEditor
          catalog={
            providers?.find((provider) => provider.id === draft.id)?.catalog
          }
          key={
            draft.existing ? draft.id : (draft.configuration.preset ?? "custom")
          }
          draft={draft}
          {...(selectedPreset === undefined ? {} : { preset: selectedPreset })}
          pending={pending !== undefined}
          testing={pending === "test"}
          fetchingModels={pending === "models"}
          onFetchModels={() => void fetchModels()}
          {...(error === undefined ? {} : { error })}
          {...(testStatus === undefined ? {} : { testStatus })}
          onChange={changeDraft}
          onClose={closeEditor}
          onSubmit={(event) => {
            event.preventDefault()
            void perform("save")
          }}
          onTest={() => void perform("test")}
          onRemove={() => void remove(draft.id)}
          {...(draft.existing && selectedPreset
            ? { onAddAnother: () => startAdding(selectedPreset) }
            : {})}
        />
      ) : null}
    </>
  )
}
