import { Check } from "lucide-react"
import { type FormEvent, useEffect, useRef, useState } from "react"
import type {
  ProviderConfiguration,
  ProviderPreset,
} from "../../protocol/providers.ts"
import { supportsOpenAIRequestWarmup } from "../../shared/request-warmup-policy.ts"
import { openUrlTarget } from "../lib/open-resource.ts"
import { createSettingsWriter } from "../lib/settings-writer.ts"
import { useAppStore } from "../store/app-store.ts"
import { ProviderLogo } from "./provider-logo.tsx"
import { ProviderModels } from "./provider-models.tsx"
import { SidebarDialog } from "./sidebar-surfaces.tsx"
import { Button } from "./ui/button.tsx"
import { Field, FieldGroup, FieldLabel, Input } from "./ui/field.tsx"
import { Select } from "./ui/select.tsx"

export type ProviderDraft = {
  id: string
  configuration: ProviderConfiguration
  apiKey: string
  existing: boolean
  availableModels?: readonly import("../../protocol/providers.ts").ConfiguredModel[]
}

export function ProviderEditor({
  draft,
  preset,
  pending,
  testing,
  fetchingModels,
  onFetchModels,
  error,
  testStatus,
  onChange,
  onClose,
  onSubmit,
  onApply,
  onTest,
  onRemove,
  onAddAnother,
}: Readonly<{
  draft: ProviderDraft
  preset?: ProviderPreset
  pending: boolean
  testing: boolean
  fetchingModels: boolean
  onFetchModels(): void
  error?: string
  testStatus?: string
  onChange(draft: ProviderDraft): void
  onClose(): void
  onSubmit(event: FormEvent<HTMLFormElement>): void
  onApply(draft: ProviderDraft): Promise<void>
  onTest(): void
  onRemove(): void
  onAddAnother?(): void
}>) {
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [openError, setOpenError] = useState<string>()
  const [modelsOpen, setModelsOpen] = useState(false)
  const [applyError, setApplyError] = useState<string>()
  const mounted = useRef(true)
  const [writer] = useState(() =>
    createSettingsWriter<ProviderDraft>({
      write: onApply,
      changed(status) {
        if (mounted.current) setApplyError(status.error)
        else if (status.error) useAppStore.setState({ message: status.error })
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
  const authentication = draft.configuration.authentication ?? "stored"
  const canLoadModels = Boolean(
    draft.configuration.baseURL.trim() &&
      (authentication === "stored"
        ? draft.apiKey.trim() || draft.existing
        : authentication === "environment"
          ? draft.configuration.envKey?.trim()
          : authentication === "none" || draft.existing),
  )
  const accountModels = draft.availableModels
  const serviceDefaults =
    !draft.existing &&
    accountModels === undefined &&
    preset &&
    draft.configuration.service === preset.id &&
    draft.configuration.wireApi === preset.wireApi &&
    draft.configuration.baseURL.replace(/\/+$/, "") ===
      preset.baseURL.replace(/\/+$/, "")
      ? preset.models
      : []
  const modelLoadHint = !draft.configuration.baseURL.trim()
    ? "Enter the API base URL to discover this account's models."
    : authentication === "stored" && !canLoadModels
      ? "Models will be discovered automatically after you enter an API key."
      : authentication === "environment" && !canLoadModels
        ? "Models will be discovered automatically after you choose an environment variable."
        : undefined
  useEffect(() => {
    if (
      !modelsOpen ||
      draft.existing ||
      !canLoadModels ||
      accountModels !== undefined ||
      pending ||
      error
    )
      return
    const timer = setTimeout(onFetchModels, 250)
    return () => clearTimeout(timer)
  }, [
    modelsOpen,
    draft,
    canLoadModels,
    accountModels,
    pending,
    error,
    onFetchModels,
  ])
  const custom = draft.configuration.preset === undefined
  const update = (patch: Partial<ProviderConfiguration>) => {
    const configuration = { ...draft.configuration, ...patch }
    if (
      configuration.requestWarmup === true &&
      (configuration.wireApi !== "openai_responses" ||
        !supportsOpenAIRequestWarmup(configuration.baseURL))
    )
      configuration.requestWarmup = false
    const next = {
      ...draft,
      configuration,
      ...(patch.authentication !== undefined &&
      patch.authentication !== "stored"
        ? { apiKey: "" }
        : {}),
    }
    onChange(next)
    if (draft.existing) writer.update(next)
  }
  return (
    <SidebarDialog
      title={
        draft.existing
          ? draft.configuration.name
          : (preset?.name ?? "Custom provider")
      }
      className="provider-editor"
      dismissible={!pending || fetchingModels}
      onClose={onClose}
    >
      <div className="provider-editor-identity">
        <ProviderLogo preset={draft.configuration.preset} />
        <p>
          {draft.existing
            ? "Manage this account and its available models."
            : custom
              ? "Connect an OpenAI, Anthropic or Gemini compatible API."
              : "Add the API key for this account."}
        </p>
        {preset ? (
          <a
            href={preset.documentationURL}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => {
              event.preventDefault()
              setOpenError(undefined)
              void openUrlTarget({
                kind: "url",
                url: preset.documentationURL,
              }).catch((cause: unknown) =>
                setOpenError(
                  cause instanceof Error
                    ? cause.message
                    : "Could not open API documentation.",
                ),
              )
            }}
          >
            API docs ↗
          </a>
        ) : null}
      </div>
      <form
        aria-label={draft.existing ? "Edit provider" : "New provider"}
        onSubmit={(event) => {
          if (draft.existing) event.preventDefault()
          else onSubmit(event)
        }}
      >
        <fieldset disabled={pending} className="provider-editor-fields">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="provider-name">Account name</FieldLabel>
              <Input
                id="provider-name"
                value={draft.configuration.name}
                onChange={(event) => update({ name: event.target.value })}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="provider-authentication">
                Authentication
              </FieldLabel>
              <Select<NonNullable<ProviderConfiguration["authentication"]>>
                id="provider-authentication"
                value={draft.configuration.authentication ?? "stored"}
                onValueChange={(authentication) => update({ authentication })}
                options={[
                  ...(draft.configuration.authentication === "codex_cli" ||
                  draft.configuration.authentication === "grok_cli"
                    ? [
                        {
                          value: draft.configuration.authentication,
                          label: "External CLI account",
                        },
                      ]
                    : []),
                  { value: "stored", label: "Saved API key" },
                  { value: "environment", label: "Environment variable" },
                  { value: "none", label: "No authentication" },
                ]}
              />
            </Field>
            {custom || draft.configuration.authentication === "none" ? (
              <EndpointField
                value={draft.configuration.baseURL}
                onChange={(baseURL) => update({ baseURL })}
              />
            ) : null}
            {(draft.configuration.authentication ?? "stored") === "stored" ? (
              <Field>
                <FieldLabel htmlFor="provider-api-key">API key</FieldLabel>
                <Input
                  id="provider-api-key"
                  type="password"
                  autoComplete="new-password"
                  data-autofocus
                  value={draft.apiKey}
                  placeholder={
                    draft.existing
                      ? "Leave blank to keep the saved key"
                      : "Paste your API key"
                  }
                  onChange={(event) => {
                    const next = { ...draft, apiKey: event.target.value }
                    onChange(next)
                    if (draft.existing) writer.update(next)
                  }}
                />
                <p className="provider-field-hint">
                  {draft.existing
                    ? "Saved keys are never displayed. Paste a new key to replace it."
                    : "Stored on this machine, separately from your configuration."}
                </p>
              </Field>
            ) : draft.configuration.authentication === "environment" ? (
              <Field>
                <FieldLabel htmlFor="provider-env-key">
                  Environment variable
                </FieldLabel>
                <Input
                  id="provider-env-key"
                  value={draft.configuration.envKey ?? ""}
                  placeholder="PROVIDER_API_KEY"
                  onChange={(event) => update({ envKey: event.target.value })}
                />
                <p className="provider-field-hint">
                  This account uses only this variable. Missing credentials
                  require reconnecting.
                </p>
              </Field>
            ) : draft.configuration.authentication === "codex_cli" ||
              draft.configuration.authentication === "grok_cli" ? (
              <p className="provider-field-hint">
                Authentication is bound to this CLI account. Reconnect it if the
                CLI changes accounts.
              </p>
            ) : (
              <p className="provider-field-hint">
                No API key needed. Start the local server, then connect.
              </p>
            )}
            {!draft.existing ? (
              <details
                className="provider-model-selection"
                open={draft.existing || undefined}
                onToggle={(event) => setModelsOpen(event.currentTarget.open)}
              >
                <summary>Model defaults (optional)</summary>
                <p className="provider-field-hint">
                  Connect to discover the models available to this account.
                  Model defaults are optional; you can also manage them on the
                  account's details page.
                </p>
                {serviceDefaults.length > 0 ? (
                  <p className="provider-field-hint">
                    Service defaults shown below. Account access has not been
                    checked.
                  </p>
                ) : null}
                {error && canLoadModels && accountModels === undefined ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pending || !canLoadModels}
                    onClick={onFetchModels}
                  >
                    Retry models
                  </Button>
                ) : null}
                {modelLoadHint ? (
                  <p className="provider-field-hint">{modelLoadHint}</p>
                ) : null}
                <ProviderModels
                  configuration={draft.configuration}
                  available={accountModels ?? serviceDefaults}
                  emptyMessage={
                    accountModels === undefined
                      ? "This account's models are discovered automatically, or you can add a model ID."
                      : "No chat models returned by this account. Check account access or add a model ID."
                  }
                  onChange={update}
                  fetchingModels={fetchingModels}
                />
              </details>
            ) : null}
            <details className="provider-advanced">
              <summary>Advanced settings</summary>
              <FieldGroup>
                {!custom && !(draft.configuration.authentication === "none") ? (
                  <>
                    <EndpointField
                      value={draft.configuration.baseURL}
                      onChange={(baseURL) => update({ baseURL })}
                    />
                    <ProtocolField
                      value={draft.configuration.wireApi}
                      onChange={(wireApi) => update({ wireApi })}
                    />
                  </>
                ) : null}
                {custom || draft.configuration.authentication === "none" ? (
                  <ProtocolField
                    value={draft.configuration.wireApi}
                    onChange={(wireApi) => update({ wireApi })}
                  />
                ) : null}
                {draft.configuration.wireApi === "openai_responses" &&
                supportsOpenAIRequestWarmup(draft.configuration.baseURL) ? (
                  <Field>
                    <label className="provider-model-option">
                      <input
                        type="checkbox"
                        checked={draft.configuration.requestWarmup === true}
                        onChange={(event) =>
                          update({ requestWarmup: event.target.checked })
                        }
                      />
                      Prepare the next request while tools run
                    </label>
                    <p className="provider-field-hint">
                      Optional OpenAI WebSocket warmup. Sends one non-generating
                      request per turn and may incur API usage. Reported tokens
                      are included in Usage. Does not save responses.
                    </p>
                  </Field>
                ) : null}
                {draft.existing ? (
                  <label className="provider-model-option">
                    <input
                      type="checkbox"
                      checked={draft.configuration.enabled !== false}
                      onChange={(event) =>
                        update({ enabled: event.target.checked })
                      }
                    />
                    Enable this account
                  </label>
                ) : null}
              </FieldGroup>
            </details>
          </FieldGroup>
        </fieldset>
        {error || openError ? (
          <p role="alert" className="provider-message text-destructive">
            {error ?? openError}
          </p>
        ) : null}
        {testStatus ? (
          <p role="status" className="provider-message provider-test-success">
            <Check size={14} />
            {testStatus}
          </p>
        ) : null}
        <div className="provider-test-row">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={
              pending ||
              draft.configuration.authentication === "codex_cli" ||
              draft.configuration.authentication === "grok_cli"
            }
            onClick={() => {
              if (draft.existing)
                void writer.flush().then((ok) => {
                  if (ok && mounted.current) onTest()
                })
              else onTest()
            }}
          >
            {testing ? "Testing…" : "Test connection"}
          </Button>
          <p className="provider-field-hint">
            Sends a small request to the first selected model; may incur API
            charges.
          </p>
        </div>
        {confirmRemove ? (
          <div className="provider-remove-confirm">
            <p>
              Remove this connection? Its models will no longer be available.
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => setConfirmRemove(false)}
            >
              Keep connection
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={pending}
              onClick={() => {
                writer.discardQueued()
                void writer.flush().then(() => {
                  if (mounted.current) onRemove()
                })
              }}
            >
              Remove
            </Button>
          </div>
        ) : (
          <div className="provider-editor-footer">
            <div className="provider-editor-secondary">
              {draft.existing ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => setConfirmRemove(true)}
                >
                  Remove provider
                </Button>
              ) : null}
              {onAddAnother ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={onAddAnother}
                >
                  Add another
                </Button>
              ) : null}
            </div>
            <div className="provider-editor-actions">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending && !fetchingModels}
                onClick={onClose}
              >
                {draft.existing ? "Done" : "Cancel"}
              </Button>
              {!draft.existing ? (
                <Button type="submit" size="sm" disabled={pending}>
                  {pending && !testing && !fetchingModels
                    ? "Connecting…"
                    : "Add account"}
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </form>
      {applyError ? (
        <div className="provider-message">
          <p role="alert">{applyError}</p>
          <Button
            type="button"
            variant="ghost"
            onClick={() => void writer.flush()}
          >
            Retry changes
          </Button>
        </div>
      ) : null}
    </SidebarDialog>
  )
}

function ProtocolField({
  value,
  onChange,
}: Readonly<{
  value: ProviderConfiguration["wireApi"]
  onChange(value: ProviderConfiguration["wireApi"]): void
}>) {
  return (
    <Field>
      <FieldLabel htmlFor="provider-protocol">API protocol</FieldLabel>
      <Select<ProviderConfiguration["wireApi"]>
        id="provider-protocol"
        value={value}
        onValueChange={onChange}
        options={[
          {
            value: "openai_chat_completions",
            label: "OpenAI Chat Completions",
          },
          { value: "openai_responses", label: "OpenAI Responses" },
          { value: "anthropic_messages", label: "Anthropic Messages" },
          { value: "gemini_generate_content", label: "Gemini GenerateContent" },
          { value: "gemini_interactions", label: "Gemini Interactions" },
        ]}
      />
    </Field>
  )
}

function EndpointField({
  value,
  onChange,
}: Readonly<{ value: string; onChange(value: string): void }>) {
  return (
    <Field>
      <FieldLabel htmlFor="provider-url">API base URL</FieldLabel>
      <Input
        id="provider-url"
        type="url"
        required
        data-autofocus
        value={value}
        placeholder="https://api.example.com/v1"
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  )
}
