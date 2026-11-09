import { Type } from "lucide-react"
import { useState } from "react"
import { sortModelCatalog } from "../../protocol/model-catalog-order.ts"
import type { ConfiguredModel } from "../../protocol/providers.ts"
import { SidebarMenu } from "./sidebar-surfaces.tsx"
import { Input } from "./ui/field.tsx"

type ModelConfiguration = Readonly<{ models: readonly ConfiguredModel[] }>

export function ProviderModels({
  configuration,
  available,
  onChange,
  fetchingModels,
  emptyMessage,
  onEditModel,
  titleModel,
  onTitleModelChange,
}: Readonly<{
  configuration: ModelConfiguration
  available: readonly ConfiguredModel[]
  onChange(patch: ModelConfiguration): void
  fetchingModels: boolean
  emptyMessage?: string
  onEditModel?(model: ConfiguredModel): void
  titleModel?: string | undefined
  onTitleModelChange?: ((modelId: string | undefined) => void) | undefined
}>) {
  const [query, setQuery] = useState("")
  const overrides = new Map(
    configuration.models.map((model) => [model.id.toLowerCase(), model]),
  )
  const choices = sortModelCatalog(
    available
      .filter((model) => model.kind === undefined || model.kind === "chat")
      .map((model) => ({
        ...model,
        ...overrides.get(model.id.toLowerCase()),
        id: model.id,
      })),
  )
  const filtered = choices.filter((model) =>
    `${model.id} ${model.displayName ?? ""}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  )
  return (
    <fieldset className="provider-models">
      <legend className="sr-only">Available models</legend>
      <div className="provider-model-toolbar">
        <Input
          type="search"
          aria-label="Filter models"
          placeholder="Filter models"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span>
          {choices.length} {choices.length === 1 ? "model" : "models"}
        </span>
      </div>
      {fetchingModels ? <p role="status">Loading models…</p> : null}
      <div className="provider-model-list">
        {filtered.map((model) => {
          const isTitleModel =
            titleModel?.toLowerCase() === model.id.toLowerCase()
          const facts = [
            model.contextWindowTokens
              ? `${new Intl.NumberFormat("en", { notation: "compact" }).format(model.contextWindowTokens)} ${model.contextWindowScope === "input" ? "input" : "context"}`
              : undefined,
            model.inputModalities?.includes("image") ? "Images" : undefined,
            model.efforts?.length ? "Reasoning" : undefined,
          ]
            .filter(Boolean)
            .join(" · ")
          const identity = (
            <>
              <span className="provider-model-name">
                {model.displayName ?? model.id}
                {isTitleModel ? (
                  <span className="provider-model-title">Title model</span>
                ) : null}
              </span>
              <code className="provider-model-id" title={model.id}>
                {model.displayName && model.displayName !== model.id
                  ? model.id
                  : ""}
              </code>
              <span className="provider-model-facts" title={facts}>
                {facts}
              </span>
            </>
          )
          const content = (
            <>
              {onEditModel ? (
                <button
                  type="button"
                  className="provider-model-main"
                  aria-label={`Edit settings for ${model.id}`}
                  onClick={() => onEditModel(model)}
                >
                  {identity}
                </button>
              ) : (
                <div className="provider-model-main">{identity}</div>
              )}
              <button
                type="button"
                role="switch"
                aria-label={`Enable ${model.displayName ?? model.id}`}
                aria-checked={model.visible !== false}
                className="provider-switch provider-model-switch"
                onClick={() =>
                  onChange({
                    models: [
                      ...configuration.models.filter(
                        (entry) =>
                          entry.id.toLowerCase() !== model.id.toLowerCase(),
                      ),
                      {
                        ...(overrides.get(model.id.toLowerCase()) ?? {
                          id: model.id,
                        }),
                        visible: model.visible === false,
                      },
                    ],
                  })
                }
              >
                <span />
              </button>
            </>
          )
          return (
            <div className="provider-model-item" key={model.id}>
              {onTitleModelChange ? (
                <SidebarMenu
                  label={`Model actions for ${model.id}`}
                  items={[
                    {
                      label: "Set as title model",
                      icon: <Type size={14} />,
                      checked: isTitleModel,
                      action: () => onTitleModelChange(model.id),
                    },
                    ...(isTitleModel
                      ? [
                          {
                            label: "Use automatic selection",
                            action: () => onTitleModelChange(undefined),
                          },
                        ]
                      : []),
                  ]}
                >
                  {content}
                </SidebarMenu>
              ) : (
                content
              )}
            </div>
          )
        })}
        {!filtered.length && !fetchingModels ? (
          <p className="provider-field-hint">
            {query
              ? "No matching models."
              : (emptyMessage ?? "No models are available for this account.")}
          </p>
        ) : null}
      </div>
    </fieldset>
  )
}
