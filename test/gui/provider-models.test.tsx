// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { ProviderModels } from "../../src/gui/components/provider-models.tsx"
import type { ProviderConfiguration } from "../../src/server/provider-configuration.ts"

const base: ProviderConfiguration = {
  name: "Service",
  wireApi: "openai_chat_completions",
  baseURL: "https://service.example/v1",
  models: [],
}
const available = [{ id: "model-a", displayName: "Model A" }, { id: "model-b" }]
afterEach(cleanup)

it.each([
  "model-a",
  "MODEL-A",
])("keeps automatic catalog selection when exposed ID %s is added", (id) => {
  const onChange = vi.fn()
  render(
    <ProviderModels
      configuration={base}
      available={available}
      onChange={onChange}
      fetchingModels={false}
    />,
  )
  fireEvent.change(screen.getByLabelText("Model ID"), { target: { value: id } })
  fireEvent.click(screen.getByRole("button", { name: "Add model" }))
  expect(onChange).not.toHaveBeenCalled()
  expect(screen.getByLabelText(/Show all models automatically/)).toHaveProperty(
    "checked",
    true,
  )
})

it("shows edits to a catalog model selected through its typed ID", () => {
  function Editor() {
    const [configuration, setConfiguration] = useState<ProviderConfiguration>({
      ...base,
      modelSelection: "selected",
    })
    return (
      <ProviderModels
        configuration={configuration}
        available={available}
        onChange={(patch) => setConfiguration({ ...configuration, ...patch })}
        fetchingModels={false}
      />
    )
  }
  render(<Editor />)
  fireEvent.change(screen.getByLabelText("Model ID"), {
    target: { value: "model-a" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Add model" }))
  const name = document.getElementById("model-name-model-a")
  if (!name) throw new Error("Missing model editor")
  fireEvent.change(name, { target: { value: "My model" } })
  expect(name).toHaveProperty("value", "My model")
  expect(
    screen.getByRole("checkbox", { name: "My model model-a" }),
  ).toHaveProperty("checked", true)
})

it("preserves automatic selection when a discovered model receives an override", () => {
  function Editor() {
    const [configuration, setConfiguration] = useState(base)
    return (
      <ProviderModels
        configuration={configuration}
        available={available}
        onChange={(patch) => setConfiguration({ ...configuration, ...patch })}
        fetchingModels={false}
      />
    )
  }
  render(<Editor />)
  const name = document.getElementById("model-name-model-a")
  if (!name) throw new Error("Missing model editor")
  fireEvent.change(name, { target: { value: "My model" } })
  expect(screen.getByLabelText(/Show all models automatically/)).toHaveProperty(
    "checked",
    true,
  )
  expect(screen.getByRole("checkbox", { name: "model-b" })).toHaveProperty(
    "checked",
    true,
  )
})

it("typing an already configured differently-cased catalog ID stays idempotent", () => {
  const onChange = vi.fn()
  render(
    <ProviderModels
      configuration={{
        ...base,
        modelSelection: "selected",
        models: [{ id: "MODEL-A", displayName: "Custom A" }],
      }}
      available={available}
      onChange={onChange}
      fetchingModels={false}
    />,
  )
  fireEvent.change(screen.getByLabelText("Model ID"), {
    target: { value: "MODEL-A" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Add model" }))
  expect(onChange).not.toHaveBeenCalled()
})
