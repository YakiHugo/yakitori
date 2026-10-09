import { Plus } from "lucide-react"
import { useState } from "react"
import type {
  ConfiguredModel,
  ProviderConfiguration,
} from "../../protocol/providers.ts"
import { Button } from "./ui/button.tsx"
import { Field, FieldGroup, FieldLabel, Input } from "./ui/field.tsx"

export function ProviderModels({
  configuration,
  available,
  onChange,
  fetchingModels,
}: Readonly<{
  configuration: ProviderConfiguration
  available: readonly ConfiguredModel[]
  onChange(patch: Partial<ProviderConfiguration>): void
  fetchingModels: boolean
}>) {
  const [query, setQuery] = useState("")
  const [typed, setTyped] = useState("")
  const [extras, setExtras] = useState<ConfiguredModel[]>([])
  const all =
    configuration.modelSelection === "all" ||
    (configuration.modelSelection !== "selected" &&
      !configuration.models.length)
  const indexed = new Map(available.map((model) => [model.id, model]))
  for (const model of [...configuration.models, ...extras])
    indexed.set(model.id, { ...indexed.get(model.id), ...model })
  const choices = [...indexed.values()]
  const selected = (model: ConfiguredModel) =>
    all || configuration.models.some((entry) => entry.id === model.id)
  const toggle = (model: ConfiguredModel, enabled: boolean) =>
    onChange({
      modelSelection: "selected",
      models: enabled
        ? [...configuration.models, { id: model.id }]
        : (all
            ? choices.map(
                (entry) =>
                  configuration.models.find(
                    (override) => override.id === entry.id,
                  ) ?? { id: entry.id },
              )
            : configuration.models
          ).filter((entry) => entry.id !== model.id),
    })
  const edit = (id: string, patch: Partial<ConfiguredModel>) => {
    const before = configuration.models.find((model) => model.id === id) ?? {
      id,
    }
    onChange({
      ...(all ? { modelSelection: "all" } : {}),
      models: [
        ...configuration.models.filter((model) => model.id !== id),
        { ...before, ...patch },
      ],
    })
  }
  const reset = (id: string, key: keyof ConfiguredModel) => {
    const next = {
      ...(configuration.models.find((model) => model.id === id) ?? { id }),
    }
    delete next[key]
    onChange({
      ...(all ? { modelSelection: "all" } : {}),
      models: [
        ...configuration.models.filter((model) => model.id !== id),
        next,
      ],
    })
  }
  const add = () => {
    const typedId = typed.trim()
    if (!typedId) return
    // Match the connection validator's case-insensitive ID uniqueness.
    const existing =
      configuration.models.find(
        (entry) => entry.id.toLowerCase() === typedId.toLowerCase(),
      ) ??
      choices.find((entry) => entry.id.toLowerCase() === typedId.toLowerCase())
    const id = existing?.id ?? typedId
    if (existing && selected(existing)) {
      setTyped("")
      setQuery("")
      return
    }
    const model = existing ?? { id }
    // Keep identity only; configuration edits and live catalog facts own metadata.
    setExtras((previous) => [
      ...previous.filter((entry) => entry.id !== id),
      { id },
    ])
    if (!configuration.models.some((entry) => entry.id === id))
      onChange({
        models: [
          ...(all
            ? choices.map(
                (entry) =>
                  configuration.models.find(
                    (override) => override.id === entry.id,
                  ) ?? { id: entry.id },
              )
            : configuration.models),
          model,
        ],
        modelSelection: "selected",
      })
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
      <label className="provider-model-option provider-model-all">
        <input
          type="checkbox"
          checked={all}
          onChange={(event) =>
            onChange({
              modelSelection: event.target.checked ? "all" : "selected",
              models: event.target.checked
                ? configuration.models
                : choices.map(
                    (entry) =>
                      configuration.models.find(
                        (override) => override.id === entry.id,
                      ) ?? { id: entry.id },
                  ),
            })
          }
        />
        <span>
          Show all models automatically
          <small>New models appear as the catalog updates.</small>
        </span>
      </label>
      {fetchingModels ? (
        <p role="status" className="provider-field-hint">
          Loading models…
        </p>
      ) : null}
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
                checked={selected(model)}
                onChange={(event) => toggle(model, event.target.checked)}
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
              <fieldset disabled={!selected(model)}>
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
                        edit(model.id, {
                          displayName: event.target.value || model.id,
                        })
                      }
                    />
                  </Field>
                  {(["contextWindowTokens", "maxOutputTokens"] as const).map(
                    (key) => (
                      <Field key={key}>
                        <FieldLabel htmlFor={`${key}-${model.id}`}>
                          {key === "contextWindowTokens"
                            ? model.contextWindowScope === "input"
                              ? "Input token limit"
                              : "Context window"
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
                  {model.efforts?.length ? (
                    <Field>
                      <FieldLabel htmlFor={`model-effort-${model.id}`}>
                        Default reasoning effort
                      </FieldLabel>
                      <select
                        id={`model-effort-${model.id}`}
                        value={model.defaultEffort ?? ""}
                        onChange={(event) => {
                          if (event.target.value)
                            edit(model.id, {
                              defaultEffort: event.target.value,
                              ...(model.efforts
                                ? { efforts: model.efforts }
                                : {}),
                            })
                          else reset(model.id, "defaultEffort")
                        }}
                      >
                        <option value="">Provider default</option>
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
                      checked={
                        model.inputModalities?.includes("image") ?? false
                      }
                      onChange={(event) =>
                        edit(model.id, {
                          inputModalities: event.target.checked
                            ? ["text", "image"]
                            : ["text"],
                        })
                      }
                    />
                    Image input
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
                        models: all
                          ? configuration.models.filter(
                              (entry) => entry.id !== model.id,
                            )
                          : configuration.models.map((entry) =>
                              entry.id === model.id ? { id: model.id } : entry,
                            ),
                      })
                    }
                  >
                    Restore model defaults
                  </Button>
                </FieldGroup>
              </fieldset>
            </details>
          </div>
        ))}
        {!filtered.length ? (
          <p className="provider-field-hint">
            {query
              ? "No matching models."
              : "Models are discovered when the connection is saved."}
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
