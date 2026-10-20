// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { ModelCatalogResponse } from "../../src/protocol/providers.ts"
import { ModelCatalogSettings } from "../../src/gui/components/model-catalog-settings.tsx"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"

const { request } = vi.hoisted(() => ({
  request:
    vi.fn<
      (method: string, params: Record<string, unknown>) => Promise<unknown>
    >(),
}))
vi.mock("../../src/gui/lib/rpc-client.ts", () => ({
  getAppRpcClient: () => ({
    request,
    subscribeToProviderChanges: () => () => {},
  }),
}))
const source: ModelCatalogResponse = {
  provider: "codex",
  version: "first",
  models: [
    {
      id: "future-coder",
      contextWindowTokens: 100000,
      efforts: ["low", "high"],
      defaultEffort: "high",
      visible: true,
    },
  ],
  settings: {},
}
beforeEach(() => {
  request.mockReset()
  request.mockImplementation(async (method) =>
    method === "provider/models/write"
      ? {
          ...source,
          settings: { "future-coder": { visible: false } },
          version: "second",
        }
      : source,
  )
  useAppStore.setState({
    ...createInitialAppState(),
    providers: [{ name: "codex", availability: "available", models: [] }],
    loadProviders: async () => {},
  })
})
afterEach(cleanup)

it("saves only the user's visibility change with the configuration version", async () => {
  render(<ModelCatalogSettings apiBase="/api" />)
  fireEvent.click(await screen.findByRole("checkbox", { name: "future-coder" }))
  fireEvent.click(screen.getByRole("button", { name: "Save model settings" }))
  await screen.findByText("Model settings saved.")
  expect(request).toHaveBeenCalledWith("provider/models/write", {
    provider: "codex",
    version: "first",
    settings: { "future-coder": { visible: false } },
  })
  expect(
    screen.getByRole("button", { name: "Save model settings" }),
  ).toHaveProperty("disabled", true)
})

it("keeps an unsaved override while refreshing provider information", async () => {
  request.mockImplementation(async (method) =>
    method === "provider/models/refresh"
      ? {
          ...source,
          models: [...source.models, { id: "later-coder", visible: true }],
        }
      : source,
  )
  render(<ModelCatalogSettings apiBase="/api" />)
  await screen.findByRole("checkbox", { name: "future-coder" })
  const name = document.getElementById("model-name-future-coder")
  if (!name) throw new Error("Missing model name editor")
  fireEvent.change(name, { target: { value: "My coder" } })
  fireEvent.click(screen.getByRole("button", { name: "Refresh models" }))
  await screen.findByRole("checkbox", { name: "later-coder" })
  expect(name).toHaveProperty("value", "My coder")
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Save model settings" }),
    ).toHaveProperty("disabled", false),
  )
})
