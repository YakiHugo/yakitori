import { FileCode2, X } from "lucide-react"
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react"
import { parse, stringify, TomlError, TomlDate } from "smol-toml"
import type {
  ConfiguredModel,
  ModelSettings,
} from "../../protocol/providers.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"

const CodeEditor = lazy(() =>
  import("./code-editor.tsx").then((module) => ({
    default: module.CodeEditor,
  })),
)

// This edits one actual config.toml table through the versioned settings API.
// It never writes the provider's discovered catalog or opens credential files.
export function ModelConfigurationPanel({
  apiBase,
  provider,
  model,
  settings,
  onChange,
  onClose,
}: Readonly<{
  apiBase: string
  provider: string
  model: ConfiguredModel
  settings: ModelSettings
  onChange(settings: ModelSettings): void
  onClose(): void
}>) {
  const [path, setPath] = useState<string>()
  const [error, setError] = useState<string>()
  const applied = useRef(settings)
  const documentFor = useCallback(
    (overrides: ModelSettings) => {
      const {
        id: _id,
        kind: _kind,
        defaultVisible: _defaultVisible,
        identity: _identity,
        ...defaults
      } = model
      const inherited = Object.fromEntries(
        Object.entries(defaults).filter(
          ([key, value]) => value !== undefined && !(key in overrides),
        ),
      )
      return `${stringify({ models: { [provider]: { [model.id]: overrides } } })}\n# Account defaults. Uncomment a value to override it.\n${stringify(
        inherited,
      )
        .split("\n")
        .map((line) => `# ${line}`)
        .join("\n")}`
    },
    [model, provider],
  )
  const [value, setValue] = useState(() => documentFor(settings))
  useEffect(() => {
    if (
      Object.keys({ ...applied.current, ...settings }).every(
        (key) =>
          JSON.stringify(applied.current[key as keyof ModelSettings]) ===
          JSON.stringify(settings[key as keyof ModelSettings]),
      )
    )
      return
    applied.current = settings
    setValue(documentFor(settings))
  }, [settings, documentFor])
  useEffect(() => {
    let active = true
    void getAppRpcClient(apiBase)
      .request("config/read", {})
      .then((snapshot) => {
        if (!active) return
        const user = snapshot.layers.find((layer) => layer.source === "user")
        if (!user) throw new Error("User configuration file is unavailable.")
        setPath(user.path)
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not locate configuration file.",
          )
      })
    return () => {
      active = false
    }
  }, [apiBase])
  return (
    <aside
      className="model-configuration-panel"
      aria-label="Model configuration"
    >
      <header>
        <FileCode2 size={17} />
        <div className="model-configuration-identity">
          <strong>config.toml</strong>
          <span title={path}>{path ?? "Locating configuration…"}</span>
        </div>
        <button
          type="button"
          aria-label="Close model configuration"
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </header>
      <div className="model-configuration-description">
        <strong>{model.displayName ?? model.id}</strong>
        <p>
          Editing this model’s overrides in the configuration file. Changes
          apply automatically; omitted values use the account’s defaults.
        </p>
      </div>
      {error ? (
        <p role="alert" className="model-configuration-error">
          {error}
        </p>
      ) : null}
      {path ? (
        <Suspense fallback={<p role="status">Loading editor…</p>}>
          <CodeEditor
            value={value}
            path={path}
            wrap
            onSave={() => {}}
            onChange={(next) => {
              setValue(next)
              try {
                const document = parse(next)
                const models = document.models
                const account =
                  typeof models === "object" &&
                  models !== null &&
                  !Array.isArray(models) &&
                  !(models instanceof TomlDate)
                    ? models[provider]
                    : undefined
                const edited =
                  typeof account === "object" &&
                  account !== null &&
                  !Array.isArray(account) &&
                  !(account instanceof TomlDate)
                    ? account[model.id]
                    : undefined
                if (
                  !edited ||
                  typeof edited !== "object" ||
                  Array.isArray(edited) ||
                  edited instanceof TomlDate ||
                  Object.keys(document).some((key) => key !== "models") ||
                  Object.keys(models ?? {}).some((key) => key !== provider) ||
                  Object.keys(account ?? {}).some((key) => key !== model.id)
                ) {
                  setError(
                    "Keep only this model’s configuration table in this editor.",
                  )
                  return
                }
                setError(undefined)
                applied.current = edited as ModelSettings
                onChange(applied.current)
              } catch (cause) {
                if (!(cause instanceof TomlError)) throw cause
                setError(cause.message)
              }
            }}
          />
        </Suspense>
      ) : null}
    </aside>
  )
}
