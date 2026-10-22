// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type {
  ModelCatalogResponse,
  ProviderModelSettings,
} from "../../src/protocol/providers.ts"
import { ModelCatalogSettings } from "../../src/gui/components/model-catalog-settings.tsx"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"

const { request, listeners } = vi.hoisted(() => ({
  request:
    vi.fn<
      (method: string, params: Record<string, unknown>) => Promise<unknown>
    >(),
  listeners: new Set<() => void>(),
}))
vi.mock("../../src/gui/components/code-editor.tsx", () => ({
  CodeEditor: ({
    value,
    path,
    onChange,
  }: {
    value: string
    path: string
    onChange(value: string): void
  }) => (
    <textarea
      aria-label={`Edit ${path}`}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}))

vi.mock("../../src/gui/lib/rpc-client.ts", () => ({
  getAppRpcClient: () => ({
    request,
    subscribeToProviderChanges: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
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
  request.mockReset().mockImplementation(async (method, params) =>
    method === "provider/models/write"
      ? { ...source, settings: params.settings, version: "second" }
      : method === "config/read"
        ? {
            layers: [
              { source: "user", path: "/home/config.toml", version: "first" },
            ],
          }
        : source,
  )
  useAppStore.setState({
    ...createInitialAppState(),
    loadProviders: async () => {},
    providerSettingsPage: {
      kind: "account",
      accountKind: "configured",
      accountId: "codex",
    },
  })
})
afterEach(() => {
  cleanup()
  listeners.clear()
})

it("applies edits without save or refresh actions", async () => {
  render(<ModelCatalogSettings apiBase="/api" provider="codex" />)
  fireEvent.click(await screen.findByRole("switch", { name: /Enable/ }))
  expect(
    screen.getByRole("switch", { name: /Enable/ }).getAttribute("aria-checked"),
  ).toBe("false")
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("provider/models/write", {
      provider: "codex",
      version: "first",
      settings: { "future-coder": { visible: false } },
    }),
  )
  expect(
    screen.queryByRole("button", { name: /Save|Refresh|Discard/ }),
  ).toBeNull()
})

it("serializes rapid edits against the last committed configuration version", async () => {
  let complete: ((value: ModelCatalogResponse) => void) | undefined
  let persisted = source
  request.mockImplementation(async (method, params) => {
    if (method === "config/read")
      return {
        layers: [
          { source: "user", path: "/home/config.toml", version: "first" },
        ],
      }
    if (method !== "provider/models/write") return persisted
    if (params.version === "first")
      return new Promise<ModelCatalogResponse>((resolve) => {
        complete = resolve
      })
    persisted = {
      ...source,
      settings: params.settings as ProviderModelSettings,
      version: "third",
    }
    return persisted
  })
  render(<ModelCatalogSettings apiBase="/api" provider="codex" />)
  fireEvent.click(await screen.findByRole("switch", { name: /Enable/ }))
  await waitFor(() => expect(complete).toBeDefined())
  fireEvent.click(
    screen.getByRole("button", { name: "Edit settings for future-coder" }),
  )
  const name = await screen.findByRole("textbox", {
    name: "Edit /home/config.toml",
  })
  fireEvent.change(name, {
    target: {
      value:
        '[models.codex.future-coder]\nvisible = false\ndisplayName = "My coder"',
    },
  })
  act(() => {
    for (const notify of listeners) notify()
  })
  expect(
    request.mock.calls.filter(([method]) => method === "provider/models/read"),
  ).toHaveLength(1)
  if (!complete) throw new Error("Missing write completion")
  await act(async () =>
    complete?.({
      ...source,
      settings: { "future-coder": { visible: false } },
      version: "second",
    }),
  )
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("provider/models/write", {
      provider: "codex",
      version: "second",
      settings: { "future-coder": { visible: false, displayName: "My coder" } },
    }),
  )
  expect(name).toHaveProperty(
    "value",
    '[models.codex.future-coder]\nvisible = false\ndisplayName = "My coder"',
  )
  await waitFor(() =>
    expect(
      request.mock.calls.filter(
        ([method]) => method === "provider/models/read",
      ),
    ).toHaveLength(2),
  )
})

it("ignores a catalog read started before a committed local edit", async () => {
  let finishRead: ((value: ModelCatalogResponse) => void) | undefined
  render(<ModelCatalogSettings apiBase="/api" provider="codex" />)
  const toggle = await screen.findByRole("switch", { name: /Enable/ })
  request.mockImplementation(async (method, params) =>
    method === "provider/models/read"
      ? new Promise<ModelCatalogResponse>((resolve) => {
          finishRead = resolve
        })
      : { ...source, settings: params.settings, version: "second" },
  )
  act(() => {
    for (const notify of listeners) notify()
  })
  fireEvent.click(toggle)
  await waitFor(() =>
    expect(screen.queryByText("Applying changes…")).toBeNull(),
  )
  expect(finishRead).toBeDefined()
  await act(async () => finishRead?.(source))
  expect(toggle.getAttribute("aria-checked")).toBe("false")
})

it("retains failed edits and retries them with a fresh configuration version", async () => {
  let writes = 0
  request.mockImplementation(async (method, params) => {
    if (method === "provider/models/read")
      return { ...source, version: writes ? "external-change" : "first" }
    writes++
    if (writes === 1) throw new Error("Configuration changed elsewhere.")
    return { ...source, settings: params.settings, version: "third" }
  })
  render(<ModelCatalogSettings apiBase="/api" provider="codex" />)
  fireEvent.click(await screen.findByRole("switch", { name: /Enable/ }))
  await screen.findByText("Configuration changed elsewhere.")
  expect(
    screen.getByRole("switch", { name: /Enable/ }).getAttribute("aria-checked"),
  ).toBe("false")
  fireEvent.click(screen.getByRole("button", { name: "Retry changes" }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("provider/models/write", {
      provider: "codex",
      version: "external-change",
      settings: { "future-coder": { visible: false } },
    }),
  )
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
})

it("flushes edits when switching accounts without applying a late response to the new account", async () => {
  let complete: ((value: ModelCatalogResponse) => void) | undefined
  const persisted = new Map<string, ProviderModelSettings>()
  request.mockImplementation(async (method, params) => {
    if (method === "provider/models/read")
      return { ...source, provider: params.provider }
    if (params.provider === "codex") {
      const result = await new Promise<ModelCatalogResponse>((resolve) => {
        complete = resolve
      })
      persisted.set("codex", params.settings as ProviderModelSettings)
      return result
    }
    return source
  })
  const view = render(<ModelCatalogSettings apiBase="/api" provider="codex" />)
  fireEvent.click(await screen.findByRole("switch", { name: /Enable/ }))
  view.rerender(<ModelCatalogSettings apiBase="/api" provider="work" />)
  await waitFor(() => expect(complete).toBeDefined())
  expect(
    (await screen.findByRole("switch", { name: /Enable/ })).getAttribute(
      "aria-checked",
    ),
  ).toBe("true")
  await act(async () =>
    complete?.({
      ...source,
      settings: { "future-coder": { visible: false } },
      version: "second",
    }),
  )
  expect(persisted.get("codex")).toEqual({ "future-coder": { visible: false } })
  expect(
    screen.getByRole("switch", { name: /Enable/ }).getAttribute("aria-checked"),
  ).toBe("true")
})

it("updates the catalog from background notifications", async () => {
  render(<ModelCatalogSettings apiBase="/api" provider="codex" />)
  await screen.findByRole("switch", { name: /Enable/ })
  request.mockResolvedValue({
    ...source,
    models: [...source.models, { id: "later-coder" }],
  })
  act(() => {
    for (const notify of listeners) notify()
  })
  await screen.findByRole("switch", { name: "Enable later-coder" })
  expect(
    request.mock.calls.every(([method]) => method === "provider/models/read"),
  ).toBe(true)
})

it("rejects invalid or unrelated TOML edits before applying model overrides", async () => {
  render(<ModelCatalogSettings apiBase="/api" provider="codex" />)
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Edit settings for future-coder",
    }),
  )
  const editor = await screen.findByRole("textbox", {
    name: "Edit /home/config.toml",
  })
  fireEvent.change(editor, { target: { value: "[" } })
  expect(screen.getByRole("alert")).toBeDefined()
  fireEvent.change(editor, {
    target: { value: "[models.other.model]\nvisible = false" },
  })
  expect(screen.getByRole("alert").textContent).toContain(
    "Keep only this model",
  )
  expect(
    request.mock.calls.filter(([method]) => method === "provider/models/write"),
  ).toHaveLength(0)
  fireEvent.change(editor, {
    target: {
      value: "[models.codex.future-coder]\ncontextWindowTokens = 64000",
    },
  })
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("provider/models/write", {
      provider: "codex",
      version: "first",
      settings: { "future-coder": { contextWindowTokens: 64000 } },
    }),
  )
  expect(screen.queryByRole("alert")).toBeNull()
  expect(screen.queryByText("Add an unlisted model")).toBeNull()
})
