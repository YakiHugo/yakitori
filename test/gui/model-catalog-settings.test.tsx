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
import { ModelCatalogSettings } from "../../src/gui/components/model-catalog-settings.tsx"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import type {
  ModelCatalogResponse,
  ProviderModelSettings,
} from "../../src/protocol/providers.ts"

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

it("autosaves title selection and restores the returned catalog selection on remount", async () => {
  let catalog = source
  request.mockImplementation(async (method, params) => {
    if (method === "provider/title-model/write") {
      const { titleModel: _titleModel, ...withoutTitleModel } = catalog
      catalog = {
        ...withoutTitleModel,
        ...(typeof params.titleModel === "string"
          ? { titleModel: params.titleModel }
          : {}),
        version: params.titleModel === null ? "third" : "second",
      }
    }
    return catalog
  })
  const view = render(<ModelCatalogSettings apiBase="/api" provider="codex" />)
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Model actions for future-coder",
    }),
  )
  fireEvent.click(
    screen.getByRole("menuitemradio", { name: "Set as title model" }),
  )
  expect(screen.getByText("Title model")).toBeDefined()
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("provider/title-model/write", {
      provider: "codex",
      titleModel: "future-coder",
      version: "first",
    }),
  )
  view.unmount()
  const reloaded = render(
    <ModelCatalogSettings apiBase="/api" provider="codex" />,
  )
  expect(await screen.findByText("Title model")).toBeDefined()
  fireEvent.click(
    screen.getByRole("button", { name: "Model actions for future-coder" }),
  )
  expect(
    screen
      .getByRole("menuitemradio", { name: "Set as title model" })
      .getAttribute("aria-checked"),
  ).toBe("true")
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Use automatic selection" }),
  )
  expect(screen.queryByText("Title model")).toBeNull()
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("provider/title-model/write", {
      provider: "codex",
      titleModel: null,
      version: "second",
    }),
  )
  reloaded.unmount()
  render(<ModelCatalogSettings apiBase="/api" provider="codex" />)
  await screen.findByRole("switch", { name: "Enable future-coder" })
  expect(screen.queryByText("Title model")).toBeNull()
  expect(
    request.mock.calls.filter(([method]) => method === "provider/models/write"),
  ).toHaveLength(0)
  expect(
    screen.queryByRole("button", { name: /Save|Refresh|Discard/ }),
  ).toBeNull()
})

it("hides title actions for accounts without title-model configuration while retaining model editing", async () => {
  render(
    <ModelCatalogSettings
      apiBase="/api"
      provider="codex"
      titleModelConfigurable={false}
    />,
  )
  await screen.findByRole("switch", { name: "Enable future-coder" })
  expect(
    screen.queryByRole("button", { name: /^Model actions for / }),
  ).toBeNull()
  expect(
    screen.getByRole("button", {
      name: "Edit settings for future-coder",
    }),
  ).toBeDefined()
  fireEvent.click(screen.getByRole("switch", { name: "Enable future-coder" }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("provider/models/write", {
      provider: "codex",
      version: "first",
      settings: { "future-coder": { visible: false } },
    }),
  )
})

it.each([
  "title",
  "visibility",
])("keeps title and visibility edits when the %s write is already in flight", async (firstEdit) => {
  let finishFirstWrite: (() => void) | undefined
  let catalog = source
  let writes = 0
  request.mockImplementation(async (method, params) => {
    if (
      method !== "provider/models/write" &&
      method !== "provider/title-model/write"
    )
      return catalog
    writes++
    if (writes === 1)
      await new Promise<void>((resolve) => {
        finishFirstWrite = resolve
      })
    catalog = {
      ...catalog,
      ...(method === "provider/models/write"
        ? { settings: params.settings as ProviderModelSettings }
        : { titleModel: params.titleModel as string }),
      version: writes === 1 ? "second" : "third",
    }
    return catalog
  })
  const view = render(<ModelCatalogSettings apiBase="/api" provider="codex" />)
  await screen.findByRole("switch", { name: "Enable future-coder" })
  const selectTitle = () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Model actions for future-coder" }),
    )
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: "Set as title model" }),
    )
  }
  const hideModel = () =>
    fireEvent.click(screen.getByRole("switch", { name: "Enable future-coder" }))
  if (firstEdit === "title") selectTitle()
  else hideModel()
  await waitFor(() => expect(finishFirstWrite).toBeDefined())
  if (firstEdit === "title") hideModel()
  else selectTitle()
  act(() => {
    for (const notify of listeners) notify()
  })
  // Let the second edit's coalescing timer expire while the first RPC is held.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300))
  })
  expect(
    request.mock.calls.filter(([method]) => method.endsWith("/write")),
  ).toHaveLength(1)
  expect(
    request.mock.calls.filter(([method]) => method === "provider/models/read"),
  ).toHaveLength(1)
  expect(screen.getByText("Title model")).toBeDefined()
  expect(
    screen
      .getByRole("switch", { name: "Enable future-coder" })
      .getAttribute("aria-checked"),
  ).toBe("false")
  await act(async () => finishFirstWrite?.())
  await waitFor(() => expect(writes).toBe(2))
  expect(
    request.mock.calls.filter(([method]) => method.endsWith("/write")),
  ).toEqual(
    firstEdit === "title"
      ? [
          [
            "provider/title-model/write",
            {
              provider: "codex",
              titleModel: "future-coder",
              version: "first",
            },
          ],
          [
            "provider/models/write",
            {
              provider: "codex",
              settings: { "future-coder": { visible: false } },
              version: "second",
            },
          ],
        ]
      : [
          [
            "provider/models/write",
            {
              provider: "codex",
              settings: { "future-coder": { visible: false } },
              version: "first",
            },
          ],
          [
            "provider/title-model/write",
            {
              provider: "codex",
              titleModel: "future-coder",
              version: "second",
            },
          ],
        ],
  )
  await waitFor(() =>
    expect(
      request.mock.calls.filter(
        ([method]) => method === "provider/models/read",
      ),
    ).toHaveLength(2),
  )
  view.unmount()
  render(<ModelCatalogSettings apiBase="/api" provider="codex" />)
  expect(await screen.findByText("Title model")).toBeDefined()
  expect(
    screen
      .getByRole("switch", { name: "Enable future-coder" })
      .getAttribute("aria-checked"),
  ).toBe("false")
  expect(screen.queryByRole("alert")).toBeNull()
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
    expect(request).toHaveBeenCalledWith("provider/models/write", {
      provider: "codex",
      version: "first",
      settings: { "future-coder": { visible: false } },
    }),
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

it("retains a title selection after a conflict and retries it with the current version", async () => {
  let writes = 0
  request.mockImplementation(async (method, params) => {
    if (method === "provider/models/read")
      return { ...source, version: writes ? "external-change" : "first" }
    if (method !== "provider/title-model/write")
      throw new Error(`Unexpected RPC: ${method}`)
    writes++
    if (writes === 1) throw new Error("Configuration changed elsewhere.")
    return { ...source, titleModel: params.titleModel, version: "third" }
  })
  render(<ModelCatalogSettings apiBase="/api" provider="codex" />)
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Model actions for future-coder",
    }),
  )
  fireEvent.click(
    screen.getByRole("menuitemradio", { name: "Set as title model" }),
  )
  await screen.findByText("Configuration changed elsewhere.")
  expect(screen.getByText("Title model")).toBeDefined()
  fireEvent.click(screen.getByRole("button", { name: "Retry changes" }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("provider/title-model/write", {
      provider: "codex",
      titleModel: "future-coder",
      version: "external-change",
    }),
  )
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
  expect(screen.getByText("Title model")).toBeDefined()
})

it("retains an external title selection when retrying only model settings", async () => {
  let catalog = source
  let modelWrites = 0
  request.mockImplementation(async (method, params) => {
    if (method === "provider/models/write") {
      modelWrites++
      if (modelWrites === 1) {
        catalog = {
          ...source,
          titleModel: "future-coder",
          version: "external-title",
        }
        throw new Error("Configuration changed elsewhere.")
      }
      catalog = {
        ...catalog,
        settings: params.settings as ProviderModelSettings,
        version: "local-model-settings",
      }
    }
    if (method === "provider/title-model/write") {
      const { titleModel: _titleModel, ...withoutTitleModel } = catalog
      catalog = {
        ...withoutTitleModel,
        ...(typeof params.titleModel === "string"
          ? { titleModel: params.titleModel }
          : {}),
        version: "local-title",
      }
    }
    return catalog
  })
  render(<ModelCatalogSettings apiBase="/api" provider="codex" />)
  fireEvent.click(await screen.findByRole("switch", { name: /Enable/ }))
  await screen.findByText("Configuration changed elsewhere.")
  fireEvent.click(screen.getByRole("button", { name: "Retry changes" }))
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
  expect(catalog.titleModel).toBe("future-coder")
  expect(catalog.settings).toEqual({ "future-coder": { visible: false } })
  expect(
    request.mock.calls.filter(
      ([method]) => method === "provider/title-model/write",
    ),
  ).toHaveLength(0)
})

it("retains external model settings when retrying only a title selection", async () => {
  let catalog = source
  let titleWrites = 0
  request.mockImplementation(async (method, params) => {
    if (method === "provider/title-model/write") {
      titleWrites++
      if (titleWrites === 1) {
        catalog = {
          ...source,
          settings: { "future-coder": { visible: false } },
          version: "external-model-settings",
        }
        throw new Error("Configuration changed elsewhere.")
      }
      catalog = {
        ...catalog,
        titleModel: String(params.titleModel),
        version: "local-title",
      }
    }
    if (method === "provider/models/write")
      catalog = {
        ...catalog,
        settings: params.settings as ProviderModelSettings,
        version: "local-model-settings",
      }
    return catalog
  })
  render(<ModelCatalogSettings apiBase="/api" provider="codex" />)
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Model actions for future-coder",
    }),
  )
  fireEvent.click(
    screen.getByRole("menuitemradio", { name: "Set as title model" }),
  )
  await screen.findByText("Configuration changed elsewhere.")
  fireEvent.click(screen.getByRole("button", { name: "Retry changes" }))
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
  expect(catalog.titleModel).toBe("future-coder")
  expect(catalog.settings).toEqual({ "future-coder": { visible: false } })
  expect(
    request.mock.calls.filter(([method]) => method === "provider/models/write"),
  ).toHaveLength(0)
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

it("edits a model using its catalog identity while retaining the existing override key", async () => {
  request.mockImplementation(async (method, params) => {
    if (method === "config/read")
      return {
        layers: [
          { source: "user", path: "/home/config.toml", version: "first" },
        ],
      }
    return {
      ...source,
      settings:
        method === "provider/models/write"
          ? params.settings
          : { "FUTURE-CODER": { displayName: "Mine" } },
    }
  })
  render(<ModelCatalogSettings apiBase="/api" provider="codex" />)
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Edit settings for future-coder",
    }),
  )
  const editor = await screen.findByRole("textbox", {
    name: "Edit /home/config.toml",
  })
  expect(editor).toHaveProperty(
    "value",
    expect.stringContaining('displayName = "Mine"'),
  )
  fireEvent.change(editor, {
    target: {
      value:
        '[models.codex.future-coder]\ndisplayName = "Mine"\ndefaultEffort = "low"',
    },
  })
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("provider/models/write", {
      provider: "codex",
      version: "first",
      settings: {
        "FUTURE-CODER": { displayName: "Mine", defaultEffort: "low" },
      },
    }),
  )
})
