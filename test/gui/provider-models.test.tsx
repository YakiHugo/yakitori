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
    screen.getByRole("button", { name: "Edit settings for model-a" }),
  )
  expect(onEditModel).toHaveBeenCalledExactlyOnceWith({
    id: "model-a",
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

it("groups versions and snapshots without changing visibility or selected IDs", () => {
  const onEditModel = vi.fn()
  render(
    <ProviderModels
      configuration={{ models: [{ id: "custom-10", visible: false }] }}
      available={[
        { id: "custom-2" },
        { id: "custom-10-2025-01-01" },
        { id: "custom-10" },
        { id: "custom-10-2025-06-01" },
      ]}
      onChange={vi.fn()}
      onEditModel={onEditModel}
      fetchingModels={false}
    />,
  )
  expect(
    screen
      .getAllByRole("switch")
      .map((item) => item.getAttribute("aria-label")),
  ).toEqual([
    "Enable custom-10",
    "Enable custom-10-2025-06-01",
    "Enable custom-10-2025-01-01",
    "Enable custom-2",
  ])
  expect(
    screen
      .getByRole("switch", { name: "Enable custom-10" })
      .getAttribute("aria-checked"),
  ).toBe("false")
  fireEvent.click(
    screen.getByRole("button", {
      name: "Edit settings for custom-10-2025-06-01",
    }),
  )
  expect(onEditModel).toHaveBeenCalledExactlyOnceWith({
    id: "custom-10-2025-06-01",
  })
})

it("shows collapsible family sections and reopens matching results when searching", () => {
  const onChange = vi.fn()
  const { container } = render(
    <ProviderModels
      configuration={{ models: [] }}
      available={[
        { id: "gpt-5" },
        { id: "gpt-6.1-sol" },
        { id: "private-deployment" },
        { id: "chatgpt-image-latest", kind: "image" },
      ]}
      onChange={onChange}
      fetchingModels={false}
    />,
  )
  expect(
    [...container.querySelectorAll("summary")].map((item) => item.textContent),
  ).toEqual(["GPT 6", "GPT 5", "Other models"])
  expect(
    screen.queryByRole("switch", { name: "Enable chatgpt-image-latest" }),
  ).toBeNull()
  const group = container.querySelector("details")
  if (!group) throw new Error("Missing model group")
  group.open = false
  fireEvent.input(screen.getByRole("searchbox"), { target: { value: "gpt-6" } })
  expect(container.querySelector("details")?.open).toBe(true)
  expect(container.querySelectorAll("summary")).toHaveLength(1)
  fireEvent.input(screen.getByRole("searchbox"), {
    target: { value: "private" },
  })
  expect(
    screen.getByRole("switch", { name: "Enable private-deployment" }),
  ).toBeTruthy()
  expect(onChange).not.toHaveBeenCalled()
})
