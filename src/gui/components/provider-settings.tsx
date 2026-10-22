import { Plus } from "lucide-react"
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
import {
  ChatGPTAccountDialogs,
  ChatGPTAccountRows,
  ChatGPTAccountActions,
} from "./chatgpt-connections.tsx"
import { useChatGPTConnections } from "./use-chatgpt-connections.ts"
import { ProviderAccountDetail } from "./provider-account-detail.tsx"
import { ProviderCatalog } from "./provider-catalog.tsx"
import { ProviderConnectionList } from "./provider-connection-list.tsx"
import { type ProviderDraft, ProviderEditor } from "./provider-editor.tsx"
import { ProviderSubscription } from "./provider-subscription.tsx"
import { SidebarDialog } from "./sidebar-surfaces.tsx"
import { Button } from "./ui/button.tsx"
import "./provider-settings.css"

export function ProviderSettings() {
  const apiBase = useAppStore((state) => state.apiBase)
  return <ProviderConnections key={apiBase} apiBase={apiBase} />
}

function ProviderConnections({ apiBase }: Readonly<{ apiBase: string }>) {
  const loadProviders = useAppStore((state) => state.loadProviders)
  const chatGPT = useChatGPTConnections(apiBase, true)
  const [providers, setProviders] = useState<readonly ApiConfiguredProvider[]>()
  const [presets, setPresets] = useState<readonly ProviderPreset[]>([])
  const page = useAppStore((state) => state.providerSettingsPage)
  const navigate = useAppStore((state) => state.setProviderSettingsPage)
  const adding = page.kind === "catalog"
  const selectedAccount =
    page.kind === "account"
      ? { kind: page.accountKind, id: page.accountId }
      : undefined
  const setAdding = (value: boolean) =>
    navigate({ kind: value ? "catalog" : "accounts" })
  const setSelectedAccount = (
    account:
      | Readonly<{ kind: "configured" | "chatgpt"; id: string }>
      | undefined,
  ) =>
    navigate(
      account
        ? { kind: "account", accountKind: account.kind, accountId: account.id }
        : { kind: "accounts" },
    )
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
  const pageKey =
    page.kind === "account"
      ? `${page.accountKind}:${page.accountId}`
      : page.kind
  // biome-ignore lint/correctness/useExhaustiveDependencies: A page change dismisses dialogs owned by the previous page.
  useEffect(() => {
    draftRevision.current++
    setDraft(undefined)
    setImporting(false)
    setError(undefined)
  }, [pageKey])

  useEffect(() => {
    if (
      chatGPT.state?.attempt?.id &&
      (chatGPT.state.attempt.state === "succeeded" ||
        chatGPT.state.attempt.state === "identity_only")
    )
      navigate({ kind: "accounts" })
  }, [chatGPT.state?.attempt?.id, chatGPT.state?.attempt?.state, navigate])

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
          authentication: preset.noKey ? "none" : "stored",
          ...(preset.envKey === undefined ? {} : { envKey: preset.envKey }),
          preset: preset.id,
          service: preset.id,
          models: [],
        }
      : {
          name: "Custom provider",
          service: "generic",
          wireApi: "openai_chat_completions",
          baseURL: "",
          authentication: "stored",
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
    const { availableModels: _previousModels, ...withoutCatalog } = next
    const sourceChanged =
      draft &&
      (draft.apiKey !== next.apiKey ||
        !sameModelCatalogSource(draft.configuration, next.configuration))
    if (sourceChanged) draftRevision.current++
    setDraft(sourceChanged ? withoutCatalog : next)
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
      ...(draft.apiKey === "" ||
      (configuration.authentication ?? "stored") !== "stored"
        ? {}
        : { apiKey: draft.apiKey }),
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
      if (selectedAccount?.kind === "configured" && selectedAccount.id === id)
        setSelectedAccount(undefined)
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
    (providers?.length ?? 0) > 0 || (chatGPT.state?.accounts.length ?? 0) > 0
  const showCatalog = providers !== undefined && adding
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
  const selectedProvider =
    selectedAccount?.kind === "configured"
      ? providers?.find((provider) => provider.id === selectedAccount.id)
      : undefined
  const selectedChatGPT =
    selectedAccount?.kind === "chatgpt"
      ? chatGPT.state?.accounts.find(
          (account) => account.id === selectedAccount.id,
        )
      : undefined
  const detail = selectedProvider
    ? {
        id: selectedProvider.id,
        name: selectedProvider.configuration.name,
        description: selectedProvider.configuration.baseURL,
      }
    : selectedChatGPT
      ? {
          id: selectedChatGPT.providerId,
          name: selectedChatGPT.label,
          description: selectedChatGPT.email,
        }
      : undefined
  return (
    <section className="provider-workspace" aria-label="Provider settings">
      <div
        className="provider-workspace-body"
        key={detail?.id ?? "account-list"}
      >
        <ChatGPTAccountDialogs connection={chatGPT} active />
        {detail ? (
          <ProviderAccountDetail
            apiBase={apiBase}
            accountId={detail.id}
            name={detail.name}
            {...(detail.description === undefined
              ? {}
              : { description: detail.description })}
            {...(selectedProvider === undefined
              ? {}
              : { configuration: selectedProvider })}
            chatGPT={selectedChatGPT !== undefined}
            modelsAvailable={
              !selectedChatGPT || selectedChatGPT.state === "connected"
            }
            onBack={() => setSelectedAccount(undefined)}
            actions={
              selectedProvider ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => edit(selectedProvider)}
                >
                  Edit connection
                </Button>
              ) : selectedChatGPT ? (
                <ChatGPTAccountActions
                  connection={chatGPT}
                  accountId={selectedChatGPT.id}
                />
              ) : null
            }
          />
        ) : (
          <>
            {!showCatalog ? (
              <div className="provider-page-heading">
                <div>
                  <h2>Accounts</h2>
                  <p>Connected models are available in every conversation.</p>
                </div>
                <Button
                  type="button"
                  disabled={providers === undefined}
                  onClick={() => setAdding(true)}
                >
                  <Plus data-icon="inline-start" />
                  Add account
                </Button>
              </div>
            ) : null}
            {providers === undefined ? (
              <div className="provider-loading">
                <p>
                  {error ? "Connections unavailable." : "Loading connections…"}
                </p>
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
                pending={pending !== undefined}
                onOpen={(provider) =>
                  setSelectedAccount({ kind: "configured", id: provider.id })
                }
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
              >
                <ChatGPTAccountRows
                  connection={chatGPT}
                  onOpen={(id) => setSelectedAccount({ kind: "chatgpt", id })}
                />
              </ProviderConnectionList>
            ) : !adding ? (
              <p className="provider-message">No accounts connected yet.</p>
            ) : null}
            {showCatalog ? (
              <ProviderCatalog
                presets={presets}
                chatGPTAvailable={(chatGPT.state?.accounts.length ?? 0) > 0}
                chatGPTPending={
                  chatGPT.pending ||
                  chatGPT.state?.attempt?.state === "waiting" ||
                  chatGPT.state === undefined
                }
                onChatGPT={() => chatGPT.open()}
                providers={providers}
                subscriptions={subscriptions}
                onPick={(preset) => startAdding(preset)}
                onSubscription={(entry) => {
                  setSubscriptionStartLogin(true)
                  setSubscriptionId(entry.id)
                }}
                onClose={() => setAdding(false)}
                onImport={() => {
                  setImporting(true)
                  setError(undefined)
                }}
              />
            ) : null}
          </>
        )}
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
              Paste a Yakitori provider connection as JSON: configuration plus
              an optional apiKey. Empty models fetch the service's catalog.
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
                        if (
                          mounted.current &&
                          pendingRequest.current === request
                        )
                          setError(
                            cause instanceof Error
                              ? cause.message
                              : "Import failed.",
                          )
                      },
                    )
                    .finally(() => {
                      if (
                        mounted.current &&
                        pendingRequest.current === request
                      ) {
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
            key={
              draft.existing
                ? draft.id
                : (draft.configuration.preset ?? "custom")
            }
            draft={draft}
            {...(selectedPreset === undefined
              ? {}
              : { preset: selectedPreset })}
            pending={pending !== undefined}
            testing={pending === "test"}
            fetchingModels={pending === "models"}
            onFetchModels={() => void fetchModels()}
            {...(error === undefined ? {} : { error })}
            {...(testStatus === undefined ? {} : { testStatus })}
            onChange={changeDraft}
            onApply={async (next) => {
              const { envKey, ...configured } = next.configuration
              const response = await getAppRpcClient(apiBase).request(
                "provider/configuration/write",
                {
                  id: next.id,
                  configuration: {
                    ...configured,
                    name: configured.name.trim(),
                    baseURL: configured.baseURL.trim(),
                    ...(envKey?.trim() ? { envKey: envKey.trim() } : {}),
                  },
                  ...(next.apiKey &&
                  (configured.authentication ?? "stored") === "stored"
                    ? { apiKey: next.apiKey }
                    : {}),
                },
              )
              if (mounted.current) {
                setProviders(response.providers)
                setPresets(response.presets)
                setSubscriptions(response.subscriptions ?? [])
                setUndoId(response.undoId)
              }
              await loadProviders()
            }}
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
      </div>
    </section>
  )
}

function sameModelCatalogSource(
  left: ProviderConfiguration | undefined,
  right: ProviderConfiguration,
): boolean {
  return (
    left !== undefined &&
    (
      [
        "service",
        "wireApi",
        "baseURL",
        "authentication",
        "envKey",
        "credentialPath",
        "credentialOwner",
      ] as const
    ).every((key) => left[key] === right[key])
  )
}
