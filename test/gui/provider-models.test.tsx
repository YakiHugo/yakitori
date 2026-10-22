// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { ProviderModels } from "../../src/gui/components/provider-models.tsx"
import type { ConfiguredModel } from "../../src/protocol/providers.ts"

const available: readonly ConfiguredModel[] = [
  { id: "model-a", displayName: "Model A", defaultEffort: "high" },
  { id: "model-b" },
]
afterEach(cleanup)

it("stores only visibility when hiding a discovered model", () => {
  const onChange = vi.fn()
  render(
    <ProviderModels
      configuration={{ models: [] }}
      available={available}
      onChange={onChange}
      fetchingModels={false}
    />,
  )
  fireEvent.click(screen.getByRole("switch", { name: "Enable Model A" }))
  expect(onChange).toHaveBeenCalledExactlyOnceWith({
    models: [{ id: "model-a", visible: false }],
  })
})

it.each([
  "model-a",
  "MODEL-A",
])("updates an existing %s override without pinning discovered defaults", (id) => {
  const onChange = vi.fn()
  render(
    <ProviderModels
      configuration={{
        models: [
          { id, displayName: "My model", efforts: ["low", "high"] },
          { id: "model-b", visible: false },
        ],
      }}
      available={available}
      onChange={onChange}
      fetchingModels={false}
    />,
  )
  fireEvent.click(screen.getByRole("switch", { name: "Enable My model" }))
  expect(onChange).toHaveBeenCalledExactlyOnceWith({
    models: [
      { id: "model-b", visible: false },
      {
        id,
        displayName: "My model",
        efforts: ["low", "high"],
        visible: false,
      },
    ],
  })
})

it("opens the selected model with its catalog capabilities and account overrides", () => {
  const onEditModel = vi.fn()
  render(
    <ProviderModels
      configuration={{ models: [{ id: "MODEL-A", displayName: "My model" }] }}
      available={available}
      onChange={vi.fn()}
      onEditModel={onEditModel}
      fetchingModels={false}
    />,
  )
  fireEvent.click(
    screen.getByRole("button", { name: "Edit settings for MODEL-A" }),
  )
  expect(onEditModel).toHaveBeenCalledExactlyOnceWith({
    id: "MODEL-A",
    displayName: "My model",
    defaultEffort: "high",
  })
})

it("keeps a hidden model disabled while enabling later catalog discoveries", () => {
  function Editor({ models }: { models: readonly ConfiguredModel[] }) {
    const [configuration, setConfiguration] = useState<{
      models: readonly ConfiguredModel[]
    }>({ models: [] })
    return (
      <ProviderModels
        configuration={configuration}
        available={models}
        fetchingModels={false}
        onChange={setConfiguration}
      />
    )
  }
  const view = render(<Editor models={available} />)
  fireEvent.click(screen.getByRole("switch", { name: "Enable Model A" }))
  view.rerender(<Editor models={[...available, { id: "new-model" }]} />)
  expect(
    screen
      .getByRole("switch", { name: "Enable Model A" })
      .getAttribute("aria-checked"),
  ).toBe("false")
  expect(
    screen
      .getByRole("switch", { name: "Enable new-model" })
      .getAttribute("aria-checked"),
  ).toBe("true")
})
