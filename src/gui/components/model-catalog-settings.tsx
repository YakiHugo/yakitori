import { useEffect, useRef, useState } from "react"
import type {
  ModelCatalogResponse,
  ProviderModelSettings,
} from "../../protocol/providers.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import { useAppStore } from "../store/app-store.ts"
import { ProviderModels } from "./provider-models.tsx"
import { Button } from "./ui/button.tsx"
import { Field, FieldLabel } from "./ui/field.tsx"

export function ModelCatalogSettings({
  apiBase,
}: Readonly<{ apiBase: string }>) {
  const providers = useAppStore((state) => state.providers)
  const [selected, setSelected] = useState("")
  const available = providers.filter(
    (provider) => provider.availability !== "requires_login",
  )
  const provider = available.some((provider) => provider.name === selected)
    ? selected
    : (available.find((provider) => provider.name !== "faux")?.name ??
      available[0]?.name)
  return (
    <section
      className="model-catalog-settings"
      aria-label="Model catalog settings"
    >
      <div className="provider-page-heading">
        <div>
          <h2>Models</h2>
          <p>Provider capabilities, app defaults, and your overrides.</p>
        </div>
      </div>
      {provider ? (
        <>
          <Field>
            <FieldLabel htmlFor="model-catalog-provider">
              Provider connection
            </FieldLabel>
            <select
              id="model-catalog-provider"
              value={provider}
              onChange={(event) => setSelected(event.target.value)}
            >
              {available.map((provider) => (
                <option key={provider.name} value={provider.name}>
                  {provider.displayName ?? provider.name}
                </option>
              ))}
            </select>
          </Field>
          <ConnectionModels
            key={`${apiBase}:${provider}`}
            apiBase={apiBase}
            provider={provider}
          />
        </>
      ) : (
        <p>Connect a provider to manage its models.</p>
      )}
    </section>
  )
}

function ConnectionModels({
  apiBase,
  provider,
}: Readonly<{ apiBase: string; provider: string }>) {
  const [catalog, setCatalog] = useState<ModelCatalogResponse>()
  const [settings, setSettings] = useState<ProviderModelSettings>({})
  const [pending, setPending] = useState<"save" | "refresh">()
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState(false)
  const [revision, setRevision] = useState(0)
  const dirty = useRef(false)
  const busy = useRef(false)
  const request = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry and discard explicitly request a fresh configuration snapshot.
  useEffect(() => {
    const client = getAppRpcClient(apiBase)
    const load = () => {
      if (dirty.current || busy.current) return
      const id = ++request.current
      void client.request("provider/models/read", { provider }).then(
        (response) => {
          if (!mounted.current || id !== request.current || dirty.current)
            return
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
  }, [apiBase, provider, revision])
  const perform = async (action: "save" | "refresh") => {
    if (!catalog) return
    const id = ++request.current
    busy.current = true
    setPending(action)
    setError(undefined)
    setSaved(false)
    try {
      const client = getAppRpcClient(apiBase)
      const response =
        action === "save"
          ? await client.request("provider/models/write", {
              provider,
              settings,
              version: catalog.version,
            })
          : await client.request("provider/models/refresh", { provider })
      if (!mounted.current || id !== request.current) return
      setCatalog(response)
      if (action === "save") {
        dirty.current = false
        setSettings(response.settings)
        setSaved(true)
      }
      if (response.error) setError(response.error)
      await useAppStore.getState().loadProviders()
    } catch (cause) {
      if (mounted.current && id === request.current)
        setError(
          cause instanceof Error ? cause.message : "Model action failed.",
        )
    } finally {
      busy.current = false
      if (mounted.current && id === request.current) setPending(undefined)
    }
  }
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
      <div className="provider-page-heading">
        <div>
          <p>
            {catalog.fetchedAt
              ? `Last updated ${new Date(catalog.fetchedAt).toLocaleString()}`
              : "Provider and app defaults"}
          </p>
          {catalog.error ? <p role="alert">{catalog.error}</p> : null}
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={pending !== undefined}
          onClick={() => void perform("refresh")}
        >
          {pending === "refresh" ? "Refreshing…" : "Refresh models"}
        </Button>
      </div>
      <fieldset disabled={pending !== undefined}>
        <ProviderModels
          configuration={{
            models: Object.entries(settings).map(([id, value]) => ({
              ...value,
              id,
            })),
          }}
          available={catalog.models}
          fetchingModels={pending === "refresh"}
          onChange={(patch) => {
            dirty.current = true
            setSaved(false)
            setSettings(
              Object.fromEntries(
                patch.models.map(({ id, ...value }) => [id, value]),
              ),
            )
          }}
        />
      </fieldset>
      {error ? (
        <p role="alert" className="provider-message">
          {error}
        </p>
      ) : null}
      {saved ? <p role="status">Model settings saved.</p> : null}
      <div className="provider-editor-actions">
        <Button
          type="button"
          disabled={pending !== undefined || !dirty.current}
          onClick={() => void perform("save")}
        >
          {pending === "save" ? "Saving…" : "Save model settings"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={pending !== undefined || !dirty.current}
          onClick={() => {
            dirty.current = false
            setSaved(false)
            setRevision((value) => value + 1)
          }}
        >
          Discard changes
        </Button>
      </div>
    </>
  )
}
