import { Check } from "lucide-react"
import { type FormEvent, useState } from "react"
import type { ProviderPreset } from "../../runtime/provider-presets.ts"
import type { ProviderConfiguration } from "../../server/provider-configuration.ts"
import { ProviderLogo } from "./provider-logo.tsx"
import { ProviderModels } from "./provider-models.tsx"
import { SidebarDialog } from "./sidebar-surfaces.tsx"
import { Button } from "./ui/button.tsx"
import { Field, FieldGroup, FieldLabel, Input } from "./ui/field.tsx"

export type ProviderDraft = {
  id: string
  configuration: ProviderConfiguration
  apiKey: string
  existing: boolean
  availableModels?: readonly import("../../runtime/provider-presets.ts").ConfiguredModel[]
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
  onTest,
  onRemove,
  onAddAnother,
  catalog,
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
  onTest(): void
  onRemove(): void
  onAddAnother?(): void
  catalog?: import("../../server/provider-configuration.ts").ApiConfiguredProvider["catalog"]
}>) {
  const [confirmRemove, setConfirmRemove] = useState(false)
  const custom = draft.configuration.preset === undefined
  const update = (patch: Partial<ProviderConfiguration>) =>
    onChange({ ...draft, configuration: { ...draft.configuration, ...patch } })
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
            ? "Manage this provider's key and models."
            : custom
              ? "Connect an OpenAI or Anthropic compatible API."
              : "Add your API key to start using this provider."}
        </p>
        {preset ? (
          <a href={preset.documentationURL} target="_blank" rel="noreferrer">
            API docs ↗
          </a>
        ) : null}
      </div>
      <form
        aria-label={draft.existing ? "Edit provider" : "New provider"}
        onSubmit={onSubmit}
      >
        <fieldset disabled={pending} className="provider-editor-fields">
          <FieldGroup>
            {custom || draft.configuration.noKey ? (
              <EndpointField
                value={draft.configuration.baseURL}
                onChange={(baseURL) => update({ baseURL })}
              />
            ) : null}
            {!draft.configuration.noKey ? (
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
                  onChange={(event) =>
                    onChange({ ...draft, apiKey: event.target.value })
                  }
                />
                <p className="provider-field-hint">
                  {draft.existing
                    ? "Saved keys are never displayed. Paste a new key to replace it."
                    : "Stored on this machine, separately from your configuration."}
                </p>
              </Field>
            ) : (
              <p className="provider-field-hint">
                No API key needed. Start the local server, then connect.
              </p>
            )}
            <details
              className="provider-model-selection"
              open={draft.existing || undefined}
              onToggle={(event) => {
                if (
                  event.currentTarget.open &&
                  !draft.existing &&
                  !catalog &&
                  !draft.availableModels &&
                  (draft.apiKey || draft.configuration.noKey)
                )
                  onFetchModels()
              }}
            >
              <summary>
                {draft.existing ? "Models" : "Choose models (optional)"}
              </summary>
              <p className="provider-field-hint">
                The service's models are discovered automatically when you
                connect. Choose which ones to show, or keep the full catalog.
              </p>
              {catalog?.error ? (
                <p role="alert" className="provider-message">
                  {catalog.error}
                  {catalog.models.length ? " Showing the saved catalog." : ""}
                </p>
              ) : null}
              <ProviderModels
                configuration={draft.configuration}
                available={draft.availableModels ?? catalog?.models ?? []}
                onChange={update}
                fetchingModels={fetchingModels}
              />
            </details>
            <details className="provider-advanced">
              <summary>Advanced settings</summary>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="provider-name">
                    Connection name
                  </FieldLabel>
                  <Input
                    id="provider-name"
                    value={draft.configuration.name}
                    onChange={(event) => update({ name: event.target.value })}
                  />
                </Field>
                {!custom && !draft.configuration.noKey ? (
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
                <Field>
                  <FieldLabel htmlFor="provider-env-key">
                    API key environment variable
                  </FieldLabel>
                  <Input
                    id="provider-env-key"
                    value={draft.configuration.envKey ?? ""}
                    placeholder="Optional, e.g. PROVIDER_API_KEY"
                    onChange={(event) => update({ envKey: event.target.value })}
                  />
                </Field>
                {custom || draft.configuration.noKey ? (
                  <ProtocolField
                    value={draft.configuration.wireApi}
                    onChange={(wireApi) => update({ wireApi })}
                  />
                ) : null}
                {custom ? (
                  <label className="provider-model-option">
                    <input
                      type="checkbox"
                      checked={draft.configuration.noKey ?? false}
                      onChange={(event) =>
                        update({ noKey: event.target.checked })
                      }
                    />
                    This service needs no API key
                  </label>
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
                    Enable this connection
                  </label>
                ) : null}
              </FieldGroup>
            </details>
          </FieldGroup>
        </fieldset>
        {error ? (
          <p role="alert" className="provider-message text-destructive">
            {error}
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
            disabled={pending}
            onClick={onTest}
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
              onClick={onRemove}
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
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={pending}>
                {pending && !testing && !fetchingModels
                  ? "Saving…"
                  : draft.existing
                    ? "Save changes"
                    : "Add provider"}
              </Button>
            </div>
          </div>
        )}
      </form>
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
      <select
        id="provider-protocol"
        value={value}
        onChange={(event) =>
          onChange(event.target.value as ProviderConfiguration["wireApi"])
        }
      >
        <option value="openai_chat_completions">OpenAI Chat Completions</option>
        <option value="openai_responses">OpenAI Responses</option>
        <option value="anthropic_messages">Anthropic Messages</option>
      </select>
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
