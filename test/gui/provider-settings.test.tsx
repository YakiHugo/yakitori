// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ProviderSettings } from "../../src/gui/components/provider-settings.tsx"
import { SettingsPage } from "../../src/gui/components/settings-page.tsx"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import type { ProviderPreset } from "../../src/runtime/provider-presets.ts"
import type { ApiConfiguredProvider } from "../../src/server/provider-configuration.ts"
import type { SubscriptionConnection } from "../../src/server/subscription-connections.ts"

const { request, loadProviders, providerChanges } = vi.hoisted(() => ({
  request:
    vi.fn<
      (method: string, params: Record<string, unknown>) => Promise<unknown>
    >(),
  loadProviders: vi.fn<() => Promise<void>>(),
  providerChanges: new Set<() => void>(),
}))

vi.mock("../../src/gui/lib/rpc-client.ts", () => ({
  getAppRpcClient: () => ({
    request,
    subscribeToProviderChanges: (listener: () => void) => {
      providerChanges.add(listener)
      return () => providerChanges.delete(listener)
    },
  }),
}))

const preset: ProviderPreset = {
  id: "deepseek",
  name: "DeepSeek",
  wireApi: "openai_chat_completions",
  baseURL: "https://api.deepseek.com",
  envKey: "DEEPSEEK_API_KEY",
  documentationURL: "https://api-docs.deepseek.com",
  models: [
    {
      id: "deepseek-chat",
      displayName: "DeepSeek Chat",
      contextWindowTokens: 128000,
      inputModalities: ["text"],
    },
    {
      id: "deepseek-reasoner",
      efforts: ["low", "high"],
      defaultEffort: "high",
    },
  ],
}

const connection: ApiConfiguredProvider = {
  id: "deepseek-work",
  configuration: {
    name: "DeepSeek work",
    wireApi: preset.wireApi,
    baseURL: preset.baseURL,
    ...(preset.envKey === undefined ? {} : { envKey: preset.envKey }),
    preset: preset.id,
    models: preset.models,
  },
  credential: "stored",
}

beforeEach(() => {
  request.mockReset().mockResolvedValue({ providers: [], presets: [preset] })
  loadProviders.mockReset().mockResolvedValue()
  useAppStore.setState({ ...createInitialAppState(), loadProviders })
})

afterEach(() => {
  cleanup()
  providerChanges.clear()
  useAppStore.setState(createInitialAppState())
})

it("starts subscription sign-in from the catalog and opens a working account import form", async () => {
  const user = userEvent.setup()
  let subscriptions: readonly SubscriptionConnection[] = [
    { id: "codex", name: "ChatGPT", available: false },
  ]
  let finish: ((result: readonly SubscriptionConnection[]) => void) | undefined
  request.mockImplementation(async (method) => {
    if (method === "provider/subscription/login") {
      subscriptions = [
        {
          id: "codex",
          name: "ChatGPT",
          available: false,
          login: { state: "running", url: "https://auth.openai.com/authorize" },
        },
      ]
      return subscriptions
    }
    if (method === "provider/subscription/cancel") {
      subscriptions = [{ id: "codex", name: "ChatGPT", available: false }]
      return subscriptions
    }
    if (method === "provider/subscription/import")
      return new Promise<readonly SubscriptionConnection[]>((resolve) => {
        finish = resolve
      })
    return { providers: [], presets: [preset], subscriptions }
  })
  render(<ProviderSettings />)
  await user.click(await screen.findByRole("button", { name: "ChatGPT" }))
  expect(request).toHaveBeenCalledWith("provider/subscription/login", {
    id: "codex",
  })
  expect(await screen.findByText("Waiting for browser sign-in…")).toBeDefined()
  await user.click(
    screen.getByRole("button", { name: "Import existing account…" }),
  )
  expect(request).toHaveBeenCalledWith("provider/subscription/cancel", {
    id: "codex",
  })
  const dialog = await screen.findByRole("dialog", {
    name: "Import ChatGPT account",
  })
  expect(
    within(dialog).getByRole("button", { name: "Choose file…" }),
  ).toBeDefined()
  await user.type(
    within(dialog).getByRole("textbox", { name: "Account JSON" }),
    "account-json",
  )
  await user.click(
    within(dialog).getByRole("button", { name: "Import account" }),
  )
  expect(request).toHaveBeenCalledWith("provider/subscription/import", {
    id: "codex",
    text: "account-json",
  })
  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    "Checking account with ChatGPT…",
  )
  expect(
    within(dialog).getByRole("button", { name: "Import account" }),
  ).toHaveProperty("disabled", true)
  subscriptions = [{ id: "codex", name: "ChatGPT", available: true }]
  await act(async () => finish?.(subscriptions))
  expect(
    await screen.findByText(
      "Account connected. Its models are available in the conversation model picker.",
    ),
  ).toBeDefined()
  await waitFor(() => expect(loadProviders).toHaveBeenCalledOnce())
  expect(screen.queryByRole("textbox", { name: "Account JSON" })).toBeNull()
})

it("shows why a local subscription account could not be imported and allows retrying", async () => {
  const user = userEvent.setup()
  const subscriptions: readonly SubscriptionConnection[] = [
    { id: "codex", name: "ChatGPT", available: false },
  ]
  request.mockImplementation(async (method) => {
    if (
      method === "provider/subscription/login" ||
      method === "provider/subscription/cancel"
    )
      return subscriptions
    if (method === "provider/subscription/import")
      throw new Error(
        "No ChatGPT account found. Sign in or choose an account file.",
      )
    return { providers: [], presets: [preset], subscriptions }
  })
  render(<ProviderSettings />)
  await user.click(await screen.findByRole("button", { name: "ChatGPT" }))
  await user.click(
    screen.getByRole("button", { name: "Import existing account…" }),
  )
  await user.click(
    screen.getByRole("button", { name: "Use local CLI account" }),
  )
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "No ChatGPT account found. Sign in or choose an account file.",
  )
  expect(
    screen.getByRole("button", { name: "Use local CLI account" }),
  ).toHaveProperty("disabled", false)
  expect(loadProviders).not.toHaveBeenCalled()
})

it("opens provider settings and saves a preset connection with an API key", async () => {
  const user = userEvent.setup()
  useAppStore.setState({ settingsSection: "general" })
  render(<SettingsPage />)
  await user.click(screen.getByRole("button", { name: "Providers" }))
  expect(await screen.findByText("Add provider")).toBeDefined()
  expect(
    screen.getByRole("region", { name: "Provider settings" }),
  ).toBeDefined()
  expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull()
  expect(
    screen.queryByRole("button", { name: "Configure with Mate" }),
  ).toBeNull()
  await user.click(screen.getByRole("button", { name: /DeepSeek/ }))
  expect(screen.getByRole("dialog", { name: "DeepSeek" })).toBeDefined()
  expect(screen.queryByLabelText("Connection ID")).toBeNull()
  expect(screen.queryByLabelText("DeepSeek Chat deepseek-chat")).toBeNull()
  expect(screen.getByLabelText("API key").getAttribute("type")).toBe("password")
  await user.type(screen.getByLabelText("API key"), "test-provider-key")
  await user.click(screen.getByRole("button", { name: "Add provider" }))
  await waitFor(() => expect(loadProviders).toHaveBeenCalledOnce())
  expect(request).toHaveBeenCalledWith("provider/configuration/write", {
    configuration: {
      name: preset.name,
      wireApi: preset.wireApi,
      baseURL: preset.baseURL,
      envKey: preset.envKey,
      preset: preset.id,
      models: [],
    },
    apiKey: "test-provider-key",
  })
  expect(screen.queryByRole("form", { name: "New provider" })).toBeNull()
})

it("retains existing model metadata and the stored key while editing model IDs", async () => {
  const user = userEvent.setup()
  request.mockResolvedValue({ providers: [connection], presets: [preset] })
  render(<ProviderSettings />)
  expect(await screen.findByText("Key saved")).toBeDefined()
  await user.click(screen.getByRole("button", { name: /^DeepSeek work/ }))
  expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("")
  await user.click(screen.getByLabelText("DeepSeek Chat deepseek-chat"))
  await user.click(screen.getByText("Add an unlisted model"))
  await user.type(screen.getByLabelText("Model ID"), " new-model ")
  await user.click(screen.getByRole("button", { name: "Add model" }))
  await user.click(screen.getByRole("button", { name: "Save changes" }))
  await waitFor(() => expect(loadProviders).toHaveBeenCalledOnce())
  expect(request).toHaveBeenCalledWith("provider/configuration/write", {
    id: connection.id,
    configuration: {
      ...connection.configuration,
      modelSelection: "selected",
      models: [preset.models[1], { id: "new-model" }],
    },
  })
})

it("keeps the form and entered key when saving fails", async () => {
  const user = userEvent.setup()
  request.mockImplementation(async (method) => {
    if (method === "provider/configuration/write")
      throw new Error("Could not save connection.")
    return { providers: [connection], presets: [preset] }
  })
  render(<ProviderSettings />)
  await user.click(
    await screen.findByRole("button", { name: /^DeepSeek work/ }),
  )
  fireEvent.change(screen.getByLabelText("Connection name"), {
    target: { value: "Renamed work connection" },
  })
  await user.type(screen.getByLabelText("API key"), "replacement-key")
  await user.click(screen.getByRole("button", { name: "Save changes" }))
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Could not save connection.",
  )
  expect(
    (screen.getByLabelText("Connection name") as HTMLInputElement).value,
  ).toBe("Renamed work connection")
  expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe(
    "replacement-key",
  )
  expect(loadProviders).not.toHaveBeenCalled()
})

it("tests the current draft only when requested and preserves it after authentication failure", async () => {
  const user = userEvent.setup()
  request.mockImplementation(async (method) => {
    if (method === "provider/configuration/test")
      throw new Error("Invalid API key.")
    return { providers: [], presets: [preset] }
  })
  render(<ProviderSettings />)
  await user.click(await screen.findByRole("button", { name: /DeepSeek/ }))
  expect(screen.getByText(/may incur API charges/)).toBeDefined()
  await user.type(screen.getByLabelText("API key"), "draft-key")
  expect(
    request.mock.calls.some(
      ([method]) => method === "provider/configuration/test",
    ),
  ).toBe(false)
  await user.click(screen.getByRole("button", { name: "Test connection" }))
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Invalid API key.",
  )
  expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe(
    "draft-key",
  )
  expect(screen.getByRole("form", { name: "New provider" })).toBeDefined()
  expect(
    request.mock.calls.some(
      ([method]) => method === "provider/configuration/write",
    ),
  ).toBe(false)
})

it("removes a connection after confirmation and refreshes model availability", async () => {
  const user = userEvent.setup()
  request.mockImplementation(async (method) => ({
    providers: method === "provider/configuration/delete" ? [] : [connection],
    presets: [preset],
  }))
  render(<ProviderSettings />)
  await user.click(
    await screen.findByRole("button", { name: /^DeepSeek work/ }),
  )
  await user.click(screen.getByRole("button", { name: "Remove provider" }))
  expect(
    request.mock.calls.some(
      ([method]) => method === "provider/configuration/delete",
    ),
  ).toBe(false)
  await user.click(screen.getByRole("button", { name: "Remove" }))
  expect(await screen.findByText("Add provider")).toBeDefined()
  expect(request).toHaveBeenCalledWith("provider/configuration/delete", {
    id: connection.id,
  })
  await waitFor(() => expect(loadProviders).toHaveBeenCalledOnce())
})

it("filters the provider catalog and returns to it without saving a cancelled draft", async () => {
  const user = userEvent.setup()
  request.mockResolvedValue({
    providers: [],
    presets: [
      preset,
      {
        ...preset,
        id: "openai",
        name: "OpenAI",
        baseURL: "https://api.openai.com/v1",
      },
    ],
  })
  render(<ProviderSettings />)
  const search = await screen.findByRole("searchbox", {
    name: "Find a provider",
  })
  await user.type(search, "api.deepseek")
  expect(screen.queryByRole("button", { name: "OpenAI" })).toBeNull()
  await user.click(screen.getByRole("button", { name: "DeepSeek" }))
  await user.type(screen.getByLabelText("API key"), "unsaved-key")
  await user.click(screen.getByRole("button", { name: "Cancel" }))
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(search).toHaveProperty("value", "api.deepseek")
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "provider/configuration/read",
  ])
  await user.click(screen.getByRole("button", { name: "DeepSeek" }))
  expect(screen.getByLabelText("API key")).toHaveProperty("value", "")
})

it("adds another preset connection with its own ID and key", async () => {
  const user = userEvent.setup()
  request.mockResolvedValue({
    providers: [{ ...connection, id: "deepseek" }],
    presets: [preset],
  })
  render(<ProviderSettings />)
  await user.click(
    await screen.findByRole("button", { name: /^DeepSeek work/ }),
  )
  await user.click(screen.getByRole("button", { name: "Add another" }))
  await user.type(screen.getByLabelText("API key"), "another-key")
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Add provider",
    }),
  )
  await waitFor(() => expect(loadProviders).toHaveBeenCalledOnce())
  expect(request).toHaveBeenCalledWith("provider/configuration/write", {
    configuration: {
      name: preset.name,
      wireApi: preset.wireApi,
      baseURL: preset.baseURL,
      envKey: preset.envKey,
      preset: preset.id,
      models: [],
    },
    apiKey: "another-key",
  })
})

it("loads the catalog when choosing models and persists a selection without copying upstream metadata", async () => {
  const user = userEvent.setup()
  request.mockImplementation(async (method) =>
    method === "provider/configuration/models"
      ? preset.models
      : { providers: [], presets: [preset] },
  )
  render(<ProviderSettings />)
  await user.click(await screen.findByRole("button", { name: "DeepSeek" }))
  await user.type(screen.getByLabelText("API key"), "catalog-key")
  await user.click(screen.getByText("Choose models (optional)"))
  await user.click(await screen.findByLabelText("DeepSeek Chat deepseek-chat"))
  await user.click(screen.getByLabelText("deepseek-reasoner"))
  await user.click(screen.getByLabelText("deepseek-reasoner"))
  await user.click(screen.getByRole("button", { name: "Add provider" }))
  await waitFor(() => expect(loadProviders).toHaveBeenCalledOnce())
  expect(request).toHaveBeenCalledWith("provider/configuration/write", {
    configuration: {
      name: preset.name,
      wireApi: preset.wireApi,
      baseURL: preset.baseURL,
      envKey: preset.envKey,
      preset: preset.id,
      modelSelection: "selected",
      models: [{ id: "deepseek-reasoner" }],
    },
    apiKey: "catalog-key",
  })
})

it("refreshes connections changed outside the form without losing an unsaved draft", async () => {
  const user = userEvent.setup()
  render(<ProviderSettings />)
  await user.click(await screen.findByRole("button", { name: "DeepSeek" }))
  await user.type(screen.getByLabelText("API key"), "unsaved-key")
  request.mockResolvedValue({ providers: [connection], presets: [preset] })
  for (const listener of providerChanges) listener()
  await user.click(screen.getByRole("button", { name: "Cancel" }))
  expect(
    await screen.findByRole("button", { name: /^DeepSeek work/ }),
  ).toBeDefined()
  expect(
    request.mock.calls.filter(
      ([method]) => method === "provider/configuration/read",
    ),
  ).toHaveLength(2)
})

it("offers every source category and connects local services without a key or model ID", async () => {
  const user = userEvent.setup()
  const local = {
    ...preset,
    id: "ollama",
    name: "Ollama",
    kind: "local",
    noKey: true,
    envKey: undefined,
    baseURL: "http://localhost:11434/v1",
    models: [],
  }
  request.mockResolvedValue({
    providers: [],
    presets: [
      preset,
      { ...preset, id: "openrouter", name: "OpenRouter", kind: "relay" },
      local,
    ],
    subscriptions: [{ id: "codex", name: "ChatGPT", available: false }],
  })
  render(<ProviderSettings />)
  for (const name of ["Subscriptions", "Vendors", "Relays", "On this machine"])
    expect(await screen.findByRole("region", { name })).toBeDefined()
  expect(screen.getByRole("button", { name: "Custom provider" })).toBeDefined()
  await user.click(screen.getByRole("button", { name: "Ollama" }))
  expect(screen.queryByLabelText("API key")).toBeNull()
  expect(screen.getByLabelText("API base URL")).toHaveProperty(
    "value",
    "http://localhost:11434/v1",
  )
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Add provider",
    }),
  )
  await waitFor(() => expect(loadProviders).toHaveBeenCalledOnce())
  expect(request).toHaveBeenCalledWith("provider/configuration/write", {
    configuration: {
      name: "Ollama",
      wireApi: preset.wireApi,
      baseURL: "http://localhost:11434/v1",
      preset: "ollama",
      models: [],
      noKey: true,
    },
  })
})

it("toggles a connection without opening a form and offers undo", async () => {
  const user = userEvent.setup()
  const disabled = {
    ...connection,
    configuration: { ...connection.configuration, enabled: false },
  }
  request.mockImplementation(async (method) =>
    method === "provider/configuration/write"
      ? { providers: [disabled], presets: [preset], undoId: "undo-test" }
      : { providers: [connection], presets: [preset] },
  )
  render(<ProviderSettings />)
  await user.click(
    await screen.findByRole("switch", { name: "Enable DeepSeek work" }),
  )
  expect(screen.queryByRole("dialog")).toBeNull()
  await waitFor(() =>
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "false",
    ),
  )
  await user.click(screen.getByRole("button", { name: "Undo" }))
  await waitFor(() =>
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "true",
    ),
  )
  expect(request).toHaveBeenCalledWith("provider/configuration/write", {
    id: connection.id,
    configuration: { ...connection.configuration, enabled: false },
  })
  expect(request).toHaveBeenCalledWith("provider/configuration/restore", {
    undoId: "undo-test",
  })
})

it("supports keyboard reordering using the logo handle", async () => {
  const user = userEvent.setup()
  const other = {
    ...connection,
    id: "deepseek-personal",
    configuration: { ...connection.configuration, name: "DeepSeek personal" },
  }
  request.mockResolvedValue({
    providers: [connection, other],
    presets: [preset],
  })
  render(<ProviderSettings />)
  const handle = await screen.findByRole("button", {
    name: "Move DeepSeek personal",
  })
  handle.focus()
  await user.keyboard("{Alt>}{ArrowUp}{/Alt}")
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("provider/configuration/move", {
      id: other.id,
      beforeId: connection.id,
    }),
  )
})

it("saves model names, reasoning defaults and explicit pricing through the same connection form", async () => {
  const user = userEvent.setup()
  request.mockResolvedValue({ providers: [connection], presets: [preset] })
  render(<ProviderSettings />)
  await user.click(
    await screen.findByRole("button", { name: /^DeepSeek work/ }),
  )
  await user.click(screen.getByLabelText("Settings for deepseek-reasoner"))
  const settings = screen.getByLabelText(
    "Settings for deepseek-reasoner",
  ).parentElement
  if (!settings) throw new Error("Missing model settings")
  await user.type(
    within(settings).getByLabelText("Display name"),
    "My reasoner",
  )
  await user.selectOptions(
    within(settings).getByLabelText("Default reasoning effort"),
    "low",
  )
  await user.click(
    within(settings).getByText("Pricing · USD per million tokens"),
  )
  await user.type(within(settings).getByLabelText("Input price"), "1.5")
  await user.type(within(settings).getByLabelText("Output price"), "6")
  await user.click(
    within(settings).getByRole("button", { name: "Apply rates" }),
  )
  await user.click(screen.getByRole("button", { name: "Save changes" }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("provider/configuration/write", {
      id: connection.id,
      configuration: {
        ...connection.configuration,
        models: [
          preset.models[0],
          {
            ...preset.models[1],
            displayName: "My reasoner",
            defaultEffort: "low",
            pricing: { inputPerMillion: 1.5, outputPerMillion: 6 },
          },
        ],
      },
    }),
  )
})

it("does not reopen a closed editor when its model catalog request completes", async () => {
  const user = userEvent.setup()
  let resolveCatalog: ((models: typeof preset.models) => void) | undefined
  const catalog = new Promise<typeof preset.models>((resolve) => {
    resolveCatalog = resolve
  })
  request.mockImplementation(async (method) =>
    method === "provider/configuration/models"
      ? catalog
      : { providers: [], presets: [preset] },
  )
  render(<ProviderSettings />)
  await user.click(await screen.findByRole("button", { name: "DeepSeek" }))
  await user.type(screen.getByLabelText("API key"), "catalog-key")
  await user.click(screen.getByText("Choose models (optional)"))
  await screen.findByText("Loading models…")
  await user.click(screen.getByRole("button", { name: "Close" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  if (!resolveCatalog) throw new Error("Missing catalog resolver")
  const complete = resolveCatalog
  await act(async () => complete(preset.models))
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull()
})
