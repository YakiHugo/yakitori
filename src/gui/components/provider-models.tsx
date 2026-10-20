import { Plus } from "lucide-react"
import { useState } from "react"
import type { ConfiguredModel } from "../../protocol/providers.ts"
import { Button } from "./ui/button.tsx"
import { Field, FieldGroup, FieldLabel, Input } from "./ui/field.tsx"

type ModelConfiguration = Readonly<{ models: readonly ConfiguredModel[] }>

export function ProviderModels({
  configuration,
  available,
  onChange,
  fetchingModels,
}: Readonly<{
  configuration: ModelConfiguration
  available: readonly ConfiguredModel[]
  onChange(patch: ModelConfiguration): void
  fetchingModels: boolean
}>) {
  const [query, setQuery] = useState("")
  const [typed, setTyped] = useState("")
  const indexed = new Map(
    available.map((model) => [model.id.toLowerCase(), model]),
  )
  for (const model of configuration.models)
    indexed.set(model.id.toLowerCase(), {
      ...indexed.get(model.id.toLowerCase()),
      ...model,
    })
  const choices = [...indexed.values()]
  const edit = (id: string, patch: Partial<ConfiguredModel>) => {
    const before = configuration.models.find(
      (model) => model.id.toLowerCase() === id.toLowerCase(),
    ) ?? { id }
    onChange({
      models: [
        ...configuration.models.filter(
          (model) => model.id.toLowerCase() !== id.toLowerCase(),
        ),
        { ...before, ...patch },
      ],
    })
  }
  const reset = (id: string, key: keyof ConfiguredModel) => {
    const model = {
      ...(configuration.models.find(
        (model) => model.id.toLowerCase() === id.toLowerCase(),
      ) ?? { id }),
    }
    delete model[key]
    onChange({
      models: [
        ...configuration.models.filter(
          (model) => model.id.toLowerCase() !== id.toLowerCase(),
        ),
        model,
      ],
    })
  }
  const add = () => {
    const id = typed.trim()
    if (!id) return
    const existing = choices.find(
      (model) => model.id.toLowerCase() === id.toLowerCase(),
    )
    if (!existing || existing.visible === false)
      edit(existing?.id ?? id, { visible: true })
    setTyped("")
    setQuery("")
  }
  const filtered = choices.filter((model) =>
    `${model.id} ${model.displayName ?? ""}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  )
  return (
    <fieldset className="provider-models">
      <legend className="sr-only">Exposed models</legend>
      <p className="provider-field-hint">
        New models follow the provider and app defaults. Your changes are kept
        when the catalog updates.
      </p>
      {fetchingModels ? <p role="status">Loading models…</p> : null}
      {choices.length > 4 ? (
        <Input
          type="search"
          aria-label="Search models"
          placeholder="Search models…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      ) : null}
      <div className="provider-model-list">
        {filtered.map((model) => (
          <div className="provider-model-item" key={model.id}>
            <label className="provider-model-option">
              <input
                type="checkbox"
                aria-label={
                  model.displayName
                    ? `${model.displayName} ${model.id}`
                    : model.id
                }
                checked={model.visible !== false}
                onChange={(event) =>
                  edit(model.id, { visible: event.target.checked })
                }
              />
              <span>
                {model.displayName ?? model.id}
                {model.displayName ? <small>{model.id}</small> : null}
              </span>
            </label>
            <div className="provider-model-facts">
              <span>
                {model.contextWindowTokens
                  ? `${new Intl.NumberFormat("en", { notation: "compact" }).format(model.contextWindowTokens)} ${model.contextWindowScope === "input" ? "input tokens" : "context"}`
                  : "Context unknown"}
              </span>
              {model.inputModalities?.includes("image") ? (
                <span>Images</span>
              ) : null}
              {model.efforts?.length ? <span>Reasoning</span> : null}
            </div>
            <details className="provider-model-settings">
              <summary aria-label={`Settings for ${model.id}`}>
                Model settings
              </summary>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor={`model-name-${model.id}`}>
                    Display name
                  </FieldLabel>
                  <Input
                    id={`model-name-${model.id}`}
                    value={model.displayName ?? ""}
                    placeholder={model.id}
                    onChange={(event) =>
                      event.target.value
                        ? edit(model.id, { displayName: event.target.value })
                        : reset(model.id, "displayName")
                    }
                  />
                </Field>
                {(["contextWindowTokens", "maxOutputTokens"] as const).map(
                  (key) => (
                    <Field key={key}>
                      <FieldLabel htmlFor={`${key}-${model.id}`}>
                        {key === "contextWindowTokens"
                          ? "Context window"
                          : "Maximum output"}
                      </FieldLabel>
                      <Input
                        id={`${key}-${model.id}`}
                        type="number"
                        min="1"
                        placeholder="Unknown"
                        value={model[key] ?? ""}
                        onChange={(event) => {
                          const value = event.target.valueAsNumber
                          if (Number.isSafeInteger(value) && value > 0)
                            edit(model.id, { [key]: value })
                          else if (!event.target.value) reset(model.id, key)
                        }}
                      />
                    </Field>
                  ),
                )}
                <Field>
                  <FieldLabel htmlFor={`context-scope-${model.id}`}>
                    Context window scope
                  </FieldLabel>
                  <select
                    id={`context-scope-${model.id}`}
                    value={model.contextWindowScope ?? ""}
                    onChange={(event) =>
                      event.target.value
                        ? edit(model.id, {
                            contextWindowScope: event.target.value as
                              | "input"
                              | "total",
                          })
                        : reset(model.id, "contextWindowScope")
                    }
                  >
                    <option value="">Source default</option>
                    <option value="input">Input tokens</option>
                    <option value="total">Input and output tokens</option>
                  </select>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`model-efforts-${model.id}`}>
                    Reasoning levels
                  </FieldLabel>
                  <Input
                    id={`model-efforts-${model.id}`}
                    key={JSON.stringify(model.efforts)}
                    defaultValue={model.efforts?.join(", ") ?? ""}
                    placeholder="Unknown · enter comma-separated levels"
                    onBlur={(event) => {
                      const efforts = event.target.value
                        .split(",")
                        .map((value) => value.trim())
                        .filter(Boolean)
                      if (
                        JSON.stringify(efforts) ===
                        JSON.stringify(model.efforts ?? [])
                      )
                        return
                      const previous = configuration.models.find(
                        (entry) => entry.id === model.id,
                      )
                      const { defaultEffort: _, ...rest } = previous ?? {
                        id: model.id,
                      }
                      onChange({
                        models: [
                          ...configuration.models.filter(
                            (entry) => entry.id !== model.id,
                          ),
                          {
                            ...rest,
                            efforts,
                            ...(previous?.defaultEffort &&
                            efforts.includes(previous.defaultEffort)
                              ? { defaultEffort: previous.defaultEffort }
                              : {}),
                          },
                        ],
                      })
                    }}
                  />
                </Field>
                {model.efforts?.length ? (
                  <Field>
                    <FieldLabel htmlFor={`model-effort-${model.id}`}>
                      Default reasoning effort
                    </FieldLabel>
                    <select
                      id={`model-effort-${model.id}`}
                      value={model.defaultEffort ?? ""}
                      onChange={(event) =>
                        event.target.value
                          ? edit(model.id, {
                              defaultEffort: event.target.value,
                            })
                          : reset(model.id, "defaultEffort")
                      }
                    >
                      <option value="">Source default</option>
                      {model.efforts.map((effort) => (
                        <option key={effort} value={effort}>
                          {effort}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : null}
                <label className="provider-model-option">
                  <input
                    type="checkbox"
                    checked={model.inputModalities?.includes("image") ?? false}
                    onChange={(event) =>
                      edit(model.id, {
                        inputModalities: event.target.checked
                          ? [
                              ...new Set<"text" | "image" | "video">([
                                ...(model.inputModalities ?? ["text"]),
                                "image",
                              ]),
                            ]
                          : (model.inputModalities ?? ["text"]).filter(
                              (value) => value !== "image",
                            ),
                      })
                    }
                  />
                  Image input
                </label>
                <label className="provider-model-option">
                  <input
                    type="checkbox"
                    checked={model.inputModalities?.includes("video") ?? false}
                    onChange={(event) =>
                      edit(model.id, {
                        inputModalities: event.target.checked
                          ? [
                              ...new Set<"text" | "image" | "video">([
                                ...(model.inputModalities ?? ["text"]),
                                "video",
                              ]),
                            ]
                          : (model.inputModalities ?? ["text"]).filter(
                              (value) => value !== "video",
                            ),
                      })
                    }
                  />
                  Video input
                </label>
                <ModelPricing
                  key={JSON.stringify(model.pricing)}
                  pricing={model.pricing}
                  onApply={(pricing) => edit(model.id, { pricing })}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    onChange({
                      models: configuration.models.filter(
                        (entry) => entry.id !== model.id,
                      ),
                    })
                  }
                >
                  Restore model defaults
                </Button>
              </FieldGroup>
            </details>
          </div>
        ))}
        {!filtered.length ? (
          <p className="provider-field-hint">
            {query
              ? "No matching models."
              : "No models listed. Refresh the catalog or add a model ID."}
          </p>
        ) : null}
      </div>
      <details className="provider-unlisted-model">
        <summary>Add an unlisted model</summary>
        <div className="provider-model-add">
          <Input
            aria-label="Model ID"
            placeholder="Upstream model ID"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault()
                add()
              }
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!typed.trim()}
            onClick={add}
          >
            <Plus data-icon="inline-start" />
            Add model
          </Button>
        </div>
      </details>
    </fieldset>
  )
}

function ModelPricing({
  pricing,
  onApply,
}: Readonly<{
  pricing: ConfiguredModel["pricing"]
  onApply(value: NonNullable<ConfiguredModel["pricing"]>): void
}>) {
  const [values, setValues] = useState({
    inputPerMillion: pricing?.inputPerMillion?.toString() ?? "",
    outputPerMillion: pricing?.outputPerMillion?.toString() ?? "",
    cacheReadPerMillion: pricing?.cacheReadPerMillion?.toString() ?? "",
    cacheWritePerMillion: pricing?.cacheWritePerMillion?.toString() ?? "",
  })
  const valid =
    values.inputPerMillion.trim() !== "" &&
    values.outputPerMillion.trim() !== "" &&
    Object.values(values).every(
      (value) =>
        value.trim() === "" ||
        (Number.isFinite(Number(value)) && Number(value) >= 0),
    )
  return (
    <details className="provider-pricing-settings">
      <summary>Pricing · USD per million tokens</summary>
      <FieldGroup>
        {(
          [
            "inputPerMillion",
            "outputPerMillion",
            "cacheReadPerMillion",
            "cacheWritePerMillion",
          ] as const
        ).map((key) => (
          <Field key={key}>
            <FieldLabel>
              {
                {
                  inputPerMillion: "Input price",
                  outputPerMillion: "Output price",
                  cacheReadPerMillion: "Cache read price",
                  cacheWritePerMillion: "Cache write price",
                }[key]
              }
              <Input
                type="number"
                min="0"
                step="any"
                value={values[key]}
                placeholder="Unknown"
                onChange={(event) =>
                  setValues({ ...values, [key]: event.target.value })
                }
              />
            </FieldLabel>
          </Field>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!valid}
          onClick={() =>
            onApply({
              inputPerMillion: Number(values.inputPerMillion),
              outputPerMillion: Number(values.outputPerMillion),
              ...(values.cacheReadPerMillion.trim() === ""
                ? {}
                : { cacheReadPerMillion: Number(values.cacheReadPerMillion) }),
              ...(values.cacheWritePerMillion.trim() === ""
                ? {}
                : {
                    cacheWritePerMillion: Number(values.cacheWritePerMillion),
                  }),
            })
          }
        >
          Apply rates
        </Button>
      </FieldGroup>
    </details>
  )
}
