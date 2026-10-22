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
import {
  providerPresets,
  type ProviderPreset,
} from "../../src/runtime/provider-presets.ts"
import type { ApiConfiguredProvider } from "../../src/server/provider-configuration.ts"
import type { SubscriptionConnection } from "../../src/server/subscription-connections.ts"

const { request, detailRequest, loadProviders, providerChanges } = vi.hoisted(
  () => ({
    request:
      vi.fn<
        (method: string, params: Record<string, unknown>) => Promise<unknown>
      >(),
    detailRequest:
      vi.fn<
        (method: string, params: Record<string, unknown>) => Promise<unknown>
      >(),
    loadProviders: vi.fn<() => Promise<void>>(),
    providerChanges: new Set<() => void>(),
  }),
)

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
    request: (method: string, params: Record<string, unknown>) =>
      method === "config/read"
        ? Promise.resolve({
            layers: [
              {
                source: "user",
                path: "/home/config.toml",
                version: "models-1",
              },
            ],
          })
        : method === "chatgpt/read"
          ? Promise.resolve({ accounts: [], welcomeRequired: false })
          : [
                "provider/models/read",
                "provider/models/write",
                "provider/models/refresh",
                "subscription/read",
              ].includes(method)
            ? detailRequest(method, params)
            : request(method, params),
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
  detailRequest.mockReset().mockImplementation(async (method, params) =>
    method === "subscription/read"
      ? {
          subscription: {
            provider: params.provider,
            displayName: "Account",
            availability: "available",
            usage: { status: "unavailable", reason: "not_supported" },
          },
          fetchedAt: 1,
        }
      : {
          provider: params.provider,
          models: preset.models,
          settings: method === "provider/models/write" ? params.settings : {},
          version: "models-1",
        },
  )
  loadProviders.mockReset().mockResolvedValue()
  useAppStore.setState({
    ...createInitialAppState(),
    loadProviders,
    loadUsage: async () => {},
  })
})

afterEach(() => {
  cleanup()
  providerChanges.clear()
  useAppStore.setState(createInitialAppState())
})

async function openAccountSettings() {
  render(<ProviderSettings />)
  const add = await screen.findByRole("button", {
    name: "Add account",
  })
  await waitFor(() => expect(add).toHaveProperty("disabled", false))
  if (!screen.queryByRole("region", { name: "Configured providers" }))
    await userEvent.setup().click(add)
}

it("keeps the outer page as an account list until adding or opening an account", async () => {
  const user = userEvent.setup()
  render(<ProviderSettings />)
  await screen.findByText("No accounts connected yet.")
  expect(screen.queryByRole("button", { name: "DeepSeek" })).toBeNull()
  expect(screen.queryByRole("tab")).toBeNull()
  await user.click(screen.getByRole("button", { name: "Add account" }))
  await screen.findByRole("button", { name: "DeepSeek" })
  await user.click(screen.getByRole("button", { name: "Back to accounts" }))
  expect(screen.getByText("No accounts connected yet.")).toBeDefined()
})

it("starts subscription sign-in from the catalog and opens a working account import form", async () => {
  const user = userEvent.setup()
  let subscriptions: readonly SubscriptionConnection[] = [
    { id: "codex", name: "Codex CLI", available: false },
  ]
  let finish: ((result: readonly SubscriptionConnection[]) => void) | undefined
  request.mockImplementation(async (method) => {
    if (method === "provider/subscription/login") {
      subscriptions = [
        {
          id: "codex",
          name: "Codex CLI",
          available: false,
          login: { state: "running", url: "https://auth.openai.com/authorize" },
        },
      ]
      return subscriptions
    }
    if (method === "provider/subscription/cancel") {
      subscriptions = [{ id: "codex", name: "Codex CLI", available: false }]
      return subscriptions
    }
    if (method === "provider/subscription/import")
      return new Promise<readonly SubscriptionConnection[]>((resolve) => {
        finish = resolve
      })
    return { providers: [], presets: [preset], subscriptions }
  })
  await openAccountSettings()
  await user.click(await screen.findByRole("button", { name: "Codex CLI" }))
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
    name: "Import Codex CLI account",
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
  subscriptions = [{ id: "codex", name: "Codex CLI", available: true }]
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
    { id: "codex", name: "Codex CLI", available: false },
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
  await openAccountSettings()
  await user.click(await screen.findByRole("button", { name: "Codex CLI" }))
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
  const navigation = screen.getByRole("complementary", {
    name: "Settings navigation",
  })
  expect(
    within(navigation)
      .getByRole("button", { name: "Providers" })
      .getAttribute("aria-current"),
  ).toBe("page")
  expect(screen.getAllByRole("button", { name: "Back to app" })).toHaveLength(1)
  expect(screen.queryByText("Use your ChatGPT plan")).toBeNull()
  await user.click(within(navigation).getByRole("button", { name: "General" }))
  await user.click(
    within(navigation).getByRole("button", { name: "Providers" }),
  )
  expect(await screen.findByText("Add account")).toBeDefined()
  expect(
    screen.getByRole("region", { name: "Provider settings" }),
  ).toBeDefined()
  expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull()
  expect(
    screen.queryByRole("button", { name: "Configure with Mate" }),
  ).toBeNull()
  await user.click(screen.getByRole("button", { name: "Add account" }))
  await user.click(screen.getByRole("button", { name: /DeepSeek/ }))
  expect(screen.getByRole("dialog", { name: "DeepSeek" })).toBeDefined()
  expect(screen.queryByLabelText("Connection ID")).toBeNull()
  expect(screen.getByLabelText("Enable DeepSeek Chat")).toHaveProperty(
    "outerHTML",
    expect.stringContaining('aria-checked="true"'),
  )
  expect(screen.getByLabelText("API key").getAttribute("type")).toBe("password")
  await user.type(screen.getByLabelText("API key"), "test-provider-key")
  await user.click(screen.getByRole("button", { name: "Add account" }))
  await waitFor(() => expect(loadProviders).toHaveBeenCalledOnce())
  expect(request).toHaveBeenCalledWith("provider/configuration/write", {
    configuration: {
      name: preset.name,
      wireApi: preset.wireApi,
      baseURL: preset.baseURL,
      envKey: preset.envKey,
      preset: preset.id,
      service: preset.id,
      authentication: "stored",
      models: [],
    },
    apiKey: "test-provider-key",
  })
  expect(screen.queryByRole("form", { name: "New provider" })).toBeNull()
})

it("preserves model metadata and the stored key when editing account information", async () => {
  const user = userEvent.setup()
  request.mockResolvedValue({ providers: [connection], presets: [preset] })
  await openAccountSettings()
  await user.click(
    await screen.findByRole("button", { name: /^DeepSeek work/ }),
  )
  expect(screen.queryByRole("tab")).toBeNull()
  await user.click(screen.getByRole("button", { name: "Edit connection" }))
  expect(screen.getByLabelText("API key")).toHaveProperty("value", "")
  await user.clear(screen.getByLabelText("Account name"))
  await user.type(screen.getByLabelText("Account name"), "Updated account")
  await waitFor(() =>
    expect(
      request.mock.calls.some(
        ([method]) => method === "provider/configuration/write",
      ),
    ).toBe(true),
  )
  expect(request).toHaveBeenCalledWith("provider/configuration/write", {
    id: connection.id,
    configuration: { ...connection.configuration, name: "Updated account" },
  })
})

it("applies the latest connection edit when the dialog closes before its write delay", async () => {
  const user = userEvent.setup()
  let stored = connection
  request.mockImplementation(async (method, params) => {
    if (method === "provider/configuration/write")
      stored = {
        ...connection,
        configuration:
          params.configuration as ApiConfiguredProvider["configuration"],
      }
    return { providers: [stored], presets: [preset] }
  })
  await openAccountSettings()
  await user.click(
    await screen.findByRole("button", { name: /^DeepSeek work/ }),
  )
  await user.click(screen.getByRole("button", { name: "Edit connection" }))
  fireEvent.change(screen.getByLabelText("Account name"), {
    target: { value: "Renamed account" },
  })
  await user.click(screen.getByRole("button", { name: "Done" }))
  await screen.findByRole("heading", { name: "Renamed account", level: 2 })
  expect(request).toHaveBeenCalledWith("provider/configuration/write", {
    id: connection.id,
    configuration: { ...connection.configuration, name: "Renamed account" },
  })
  expect(screen.queryByRole("dialog")).toBeNull()
})

it("opens model and usage details for the clicked account without requesting other accounts", async () => {
  const user = userEvent.setup()
  const personal = {
    ...connection,
    id: "deepseek-personal",
    configuration: { ...connection.configuration, name: "DeepSeek personal" },
  }
  request.mockResolvedValue({
    providers: [connection, personal],
    presets: [preset],
  })
  await openAccountSettings()
  await screen.findByRole("button", { name: /^DeepSeek work/ })
  expect(screen.queryByRole("tab")).toBeNull()
  expect(detailRequest).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: /^DeepSeek work/ }))
  await screen.findByRole("region", { name: "Account models" })
  expect(detailRequest).toHaveBeenCalledWith("provider/models/read", {
    provider: "deepseek-work",
  })
  expect(detailRequest).toHaveBeenCalledWith("subscription/read", {
    provider: "deepseek-work",
  })
  expect(
    detailRequest.mock.calls.every(
      ([, params]) => params.provider === "deepseek-work",
    ),
  ).toBe(true)
  await user.click(screen.getByRole("button", { name: "Back to accounts" }))
  expect(screen.queryByRole("region", { name: "Provider usage" })).toBeNull()
  await user.click(screen.getByRole("button", { name: /^DeepSeek personal/ }))
  expect(detailRequest).toHaveBeenCalledWith("provider/models/read", {
    provider: "deepseek-personal",
  })
  expect(detailRequest).toHaveBeenCalledWith("subscription/read", {
    provider: "deepseek-personal",
  })
})

it("preserves an existing Gemini compatibility connection when the native preset changes", async () => {
  const user = userEvent.setup()
  const compatibility: ApiConfiguredProvider = {
    id: "gemini-compatibility",
    credential: "stored",
    configuration: {
      name: "Gemini compatibility",
      preset: "gemini",
      service: "gemini",
      authentication: "stored",
      wireApi: "openai_chat_completions",
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
      models: [{ id: "gemini-3.8-flash" }],
    },
  }
  request.mockResolvedValue({
    providers: [compatibility],
    presets: providerPresets,
  })
  await openAccountSettings()
  await user.click(
    await screen.findByRole("button", { name: /^Gemini compatibility/ }),
  )
  await user.click(screen.getByRole("button", { name: "Edit connection" }))
  await user.click(screen.getByText("Advanced settings"))
  expect(
    (screen.getByLabelText("API protocol") as HTMLSelectElement).value,
  ).toBe("openai_chat_completions")
  expect(
    (screen.getByLabelText("API base URL") as HTMLInputElement).value,
  ).toBe("https://generativelanguage.googleapis.com/v1beta/openai/")
  fireEvent.change(screen.getByLabelText("Account name"), {
    target: { value: "Gemini work" },
  })
  await waitFor(() =>
    expect(
      request.mock.calls.some(
        ([method]) => method === "provider/configuration/write",
      ),
    ).toBe(true),
  )
  await waitFor(() => expect(loadProviders).toHaveBeenCalledOnce())
  expect(request).toHaveBeenCalledWith("provider/configuration/write", {
    id: "gemini-compatibility",
    configuration: { ...compatibility.configuration, name: "Gemini work" },
  })
})

it("saves a new Gemini preset connection with the native protocol and endpoint", async () => {
  const user = userEvent.setup()
  request.mockResolvedValue({ providers: [], presets: providerPresets })
  await openAccountSettings()
  await user.click(await screen.findByRole("button", { name: "Google Gemini" }))
  await user.click(screen.getByText("Advanced settings"))
  expect(
    (screen.getByLabelText("API protocol") as HTMLSelectElement).value,
  ).toBe("gemini_generate_content")
  await user.selectOptions(
    screen.getByLabelText("API protocol"),
    "openai_chat_completions",
  )
  await user.selectOptions(
    screen.getByLabelText("API protocol"),
    "gemini_generate_content",
  )
  await user.type(screen.getByLabelText("API key"), "native-test-key")
  await user.click(screen.getByRole("button", { name: "Add account" }))
  await waitFor(() => expect(loadProviders).toHaveBeenCalledOnce())
  expect(request).toHaveBeenCalledWith("provider/configuration/write", {
    configuration: {
      name: "Google Gemini",
      preset: "gemini",
      service: "gemini",
      authentication: "stored",
      wireApi: "gemini_generate_content",
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
      envKey: "GEMINI_API_KEY",
      models: [],
    },
    apiKey: "native-test-key",
  })
})

it("keeps the form and entered key when saving fails", async () => {
  const user = userEvent.setup()
  request.mockImplementation(async (method) => {
    if (method === "provider/configuration/write")
      throw new Error("Could not save connection.")
    return { providers: [connection], presets: [preset] }
  })
  await openAccountSettings()
  await user.click(
    await screen.findByRole("button", { name: /^DeepSeek work/ }),
  )
  await user.click(screen.getByRole("button", { name: "Edit connection" }))
  fireEvent.change(screen.getByLabelText("Account name"), {
    target: { value: "Renamed work connection" },
  })
  await user.type(screen.getByLabelText("API key"), "replacement-key")
  await waitFor(() =>
    expect(
      request.mock.calls.some(
        ([method]) => method === "provider/configuration/write",
      ),
    ).toBe(true),
  )
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Could not save connection.",
  )
  expect(
    (screen.getByLabelText("Account name") as HTMLInputElement).value,
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
  await openAccountSettings()
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
  await openAccountSettings()
  await user.click(
    await screen.findByRole("button", { name: /^DeepSeek work/ }),
  )
  await user.click(screen.getByRole("button", { name: "Edit connection" }))
  await user.click(screen.getByRole("button", { name: "Remove provider" }))
  expect(
    request.mock.calls.some(
      ([method]) => method === "provider/configuration/delete",
    ),
  ).toBe(false)
  await user.click(screen.getByRole("button", { name: "Remove" }))
  expect(await screen.findByText("Add account")).toBeDefined()
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
  await openAccountSettings()
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
  await openAccountSettings()
  await user.click(
    await screen.findByRole("button", { name: /^DeepSeek work/ }),
  )
  await user.click(screen.getByRole("button", { name: "Edit connection" }))
  await user.click(screen.getByRole("button", { name: "Add another" }))
  await user.type(screen.getByLabelText("API key"), "another-key")
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Add account",
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
      service: preset.id,
      authentication: "stored",
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
  await openAccountSettings()
  await user.click(await screen.findByRole("button", { name: "DeepSeek" }))
  await user.type(screen.getByLabelText("API key"), "catalog-key")
  await user.click(screen.getByText("Model defaults (optional)"))
  await user.click(await screen.findByLabelText("Enable DeepSeek Chat"))
  await user.click(screen.getByLabelText("Enable deepseek-reasoner"))
  await user.click(screen.getByLabelText("Enable deepseek-reasoner"))
  await user.click(screen.getByRole("button", { name: "Add account" }))
  await waitFor(() => expect(loadProviders).toHaveBeenCalledOnce())
  expect(request).toHaveBeenCalledWith("provider/configuration/write", {
    configuration: {
      name: preset.name,
      wireApi: preset.wireApi,
      baseURL: preset.baseURL,
      envKey: preset.envKey,
      preset: preset.id,
      service: preset.id,
      authentication: "stored",
      models: [
        { id: "deepseek-chat", visible: false },
        { id: "deepseek-reasoner", visible: true },
      ],
    },
    apiKey: "catalog-key",
  })
})

it("refreshes connections changed outside the form without losing an unsaved draft", async () => {
  const user = userEvent.setup()
  await openAccountSettings()
  await user.click(await screen.findByRole("button", { name: "DeepSeek" }))
  await user.type(screen.getByLabelText("API key"), "unsaved-key")
  request.mockResolvedValue({ providers: [connection], presets: [preset] })
  await act(async () => {
    for (const listener of providerChanges) listener()
  })
  expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe(
    "unsaved-key",
  )
  await user.click(screen.getByRole("button", { name: "Cancel" }))
  await user.click(screen.getByRole("button", { name: "Back to accounts" }))
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
    subscriptions: [{ id: "codex", name: "Codex CLI", available: false }],
  })
  await openAccountSettings()
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
      name: "Add account",
    }),
  )
  await waitFor(() => expect(loadProviders).toHaveBeenCalledOnce())
  expect(request).toHaveBeenCalledWith("provider/configuration/write", {
    configuration: {
      name: "Ollama",
      wireApi: preset.wireApi,
      baseURL: "http://localhost:11434/v1",
      preset: "ollama",
      service: "ollama",
      models: [],
      authentication: "none",
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
  await openAccountSettings()
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
  await openAccountSettings()
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

it("saves model names, reasoning defaults and explicit pricing through the selected account detail", async () => {
  const user = userEvent.setup()
  request.mockResolvedValue({ providers: [connection], presets: [preset] })
  await openAccountSettings()
  await user.click(
    await screen.findByRole("button", { name: /^DeepSeek work/ }),
  )
  await user.click(
    screen.getByRole("button", { name: "Edit settings for deepseek-reasoner" }),
  )
  const editor = await screen.findByRole("textbox", {
    name: "Edit /home/config.toml",
  })
  fireEvent.change(editor, {
    target: {
      value:
        '[models.deepseek-work.deepseek-reasoner]\ndisplayName = "My reasoner"\ndefaultEffort = "low"\n[models.deepseek-work.deepseek-reasoner.pricing]\ninputPerMillion = 1.5\noutputPerMillion = 6',
    },
  })
  await waitFor(() =>
    expect(detailRequest).toHaveBeenCalledWith("provider/models/write", {
      provider: connection.id,
      version: "models-1",
      settings: {
        "deepseek-reasoner": {
          displayName: "My reasoner",
          defaultEffort: "low",
          pricing: { inputPerMillion: 1.5, outputPerMillion: 6 },
        },
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
  await openAccountSettings()
  await user.click(await screen.findByRole("button", { name: "DeepSeek" }))
  await user.type(screen.getByLabelText("API key"), "catalog-key")
  await user.click(screen.getByText("Model defaults (optional)"))
  await screen.findByText("Loading models…")
  await user.click(screen.getByRole("button", { name: "Close" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  if (!resolveCatalog) throw new Error("Missing catalog resolver")
  const complete = resolveCatalog
  await act(async () => complete(preset.models))
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull()
})

it("keeps a new editor locked to its own model request after an older request completes", async () => {
  const user = userEvent.setup()
  const localPreset = {
    ...preset,
    id: "local",
    name: "Local API",
    noKey: true,
    baseURL: "http://localhost:11434/v1",
  }
  const completions: ((models: typeof preset.models) => void)[] = []
  request.mockImplementation(async (method) => {
    if (method === "provider/configuration/models")
      return new Promise<typeof preset.models>((resolve) =>
        completions.push(resolve),
      )
    return { providers: [], presets: [preset, localPreset] }
  })
  await openAccountSettings()
  await user.click(await screen.findByRole("button", { name: "DeepSeek" }))
  await user.type(screen.getByLabelText("API key"), "catalog-key")
  await user.click(screen.getByText("Model defaults (optional)"))
  await screen.findByText("Loading models…")
  await user.click(screen.getByRole("button", { name: "Close" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  await user.click(await screen.findByRole("button", { name: "Local API" }))
  expect(
    screen.getByLabelText("API base URL").closest("fieldset"),
  ).toHaveProperty("disabled", false)
  await user.click(screen.getByText("Model defaults (optional)"))
  await waitFor(() => expect(completions).toHaveLength(2))
  await act(async () => completions[0]?.([{ id: "stale-model" }]))
  expect(screen.getByText("Loading models…")).toBeDefined()
  expect(
    screen.getByLabelText("API base URL").closest("fieldset"),
  ).toHaveProperty("disabled", true)
  expect(screen.queryByText("stale-model")).toBeNull()
  await act(async () => completions[1]?.([{ id: "current-model" }]))
  expect(screen.queryByText("Loading models…")).toBeNull()
  expect(
    screen.getByLabelText("API base URL").closest("fieldset"),
  ).toHaveProperty("disabled", false)
  expect(screen.getByText("current-model")).toBeDefined()
})

it.each([
  "success",
  "failure",
] as const)("keeps a new model request pending after a dismissed import's %s", async (outcome) => {
  const user = userEvent.setup()
  let finishImport:
    | Readonly<{ resolve(value: unknown): void; reject(error: Error): void }>
    | undefined
  let finishModels: ((value: typeof preset.models) => void) | undefined
  request.mockImplementation(async (method) => {
    if (method === "provider/configuration/write")
      return new Promise((resolve, reject) => {
        finishImport = { resolve, reject }
      })
    if (method === "provider/configuration/models")
      return new Promise<typeof preset.models>((resolve) => {
        finishModels = resolve
      })
    return { providers: [], presets: [preset], subscriptions: [] }
  })
  await openAccountSettings()
  await user.click(await screen.findByRole("button", { name: "Import…" }))
  const importDialog = screen.getByRole("dialog", { name: "Import provider" })
  fireEvent.change(screen.getByLabelText("Provider configuration JSON"), {
    target: {
      value: JSON.stringify({
        configuration: {
          name: "Imported source",
          wireApi: "openai_chat_completions",
          baseURL: "http://localhost:11434/v1",
          models: [],
          authentication: "none",
        },
      }),
    },
  })
  await user.click(within(importDialog).getByRole("button", { name: "Import" }))
  await waitFor(() => expect(finishImport).toBeDefined())
  await user.click(within(importDialog).getByRole("button", { name: "Cancel" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  await user.click(screen.getByRole("button", { name: "DeepSeek" }))
  await user.type(screen.getByLabelText("API key"), "new-source-key")
  await user.click(screen.getByText("Model defaults (optional)"))
  await screen.findByText("Loading models…")
  const completion = finishImport
  if (!completion) throw new Error("Missing import completion")
  await act(async () => {
    if (outcome === "success")
      completion.resolve({
        providers: [connection],
        presets: [preset],
        subscriptions: [],
        undoId: "stale-import",
      })
    else completion.reject(new Error("Previous import failed."))
  })
  expect(screen.getByText("Loading models…")).toBeDefined()
  expect(screen.getByLabelText("API key")).toHaveProperty(
    "value",
    "new-source-key",
  )
  expect(screen.getByLabelText("API key").closest("fieldset")).toHaveProperty(
    "disabled",
    true,
  )
  expect(screen.queryByRole("alert")).toBeNull()
  expect(screen.queryByText("Connection updated.")).toBeNull()
  await act(async () => finishModels?.([{ id: "new-source-model" }]))
  expect(screen.getByText("new-source-model")).toBeDefined()
  expect(screen.getByLabelText("API key").closest("fieldset")).toHaveProperty(
    "disabled",
    false,
  )
})

it.each([
  "documentation",
  "sign-in",
] as const)("opens provider %s links through the desktop browser bridge", async (kind) => {
  const openUrl = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(window, "yakitoriDesktop", {
    configurable: true,
    value: { openUrl },
  })
  const url =
    kind === "documentation"
      ? preset.documentationURL
      : "https://auth.example.com/authorize"
  request.mockImplementation(async (method) => {
    const subscriptions = [
      {
        id: "grok",
        name: "Grok CLI",
        available: false,
        login: { state: "running", url },
      },
    ]
    return method === "provider/subscription/login"
      ? subscriptions
      : { providers: [], presets: [preset], subscriptions }
  })
  try {
    await openAccountSettings()
    fireEvent.click(
      await screen.findByRole("button", {
        name: kind === "documentation" ? "DeepSeek" : "Grok CLI",
      }),
    )
    const link = await screen.findByRole("link", {
      name: kind === "documentation" ? "API docs ↗" : "Open sign-in page ↗",
    })
    // Suppress the test DOM's real navigation; the bridge is the contract.
    link.addEventListener("click", (event) => event.preventDefault())
    fireEvent.click(link)
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith({ url }))
  } finally {
    Object.defineProperty(window, "yakitoriDesktop", {
      configurable: true,
      value: undefined,
    })
  }
})

it("drops an entered key when the account switches to environment authentication", async () => {
  const user = userEvent.setup()
  await openAccountSettings()
  await user.click(await screen.findByRole("button", { name: "DeepSeek" }))
  await user.type(screen.getByLabelText("API key"), "discarded-key")
  await user.selectOptions(
    screen.getByLabelText("Authentication"),
    "environment",
  )
  expect(screen.queryByLabelText("API key")).toBeNull()
  await user.click(screen.getByRole("button", { name: "Add account" }))
  await waitFor(() => expect(loadProviders).toHaveBeenCalledOnce())
  const write = request.mock.calls.find(
    ([method]) => method === "provider/configuration/write",
  )
  expect(write?.[1]).toMatchObject({
    configuration: { authentication: "environment", envKey: preset.envKey },
  })
  expect(write?.[1]).not.toHaveProperty("apiKey")
})

it("shows service defaults before authentication and loads account models after the open editor receives a key", async () => {
  const kimi = providerPresets.find((preset) => preset.id === "kimi-code")
  if (!kimi) throw new Error("Missing Kimi Code template")
  request.mockImplementation(async (method) =>
    method === "provider/configuration/models"
      ? [{ id: "account-coder", displayName: "Account coder" }]
      : { providers: [], presets: [kimi] },
  )
  const user = userEvent.setup()
  await openAccountSettings()
  await user.click(await screen.findByRole("button", { name: "Kimi Code" }))
  await user.click(screen.getByText("Model defaults (optional)"))
  expect(screen.getByLabelText("Enable kimi-for-coding")).toHaveProperty(
    "outerHTML",
    expect.stringContaining('aria-checked="true"'),
  )
  expect(
    screen.getByText(
      "Service defaults shown below. Account access has not been checked.",
    ),
  ).toBeDefined()
  expect(
    screen.queryByRole("button", { name: /Load models|Refresh models/ }),
  ).toBeNull()
  expect(
    screen.getByText(
      "Models will be discovered automatically after you enter an API key.",
    ),
  ).toBeDefined()
  expect(
    request.mock.calls.filter(
      ([method]) => method === "provider/configuration/models",
    ),
  ).toHaveLength(0)
  await user.type(screen.getByLabelText("API key"), "test-kimi-key")
  expect(
    await screen.findByRole("switch", {
      name: "Enable Account coder",
    }),
  ).toHaveProperty("outerHTML", expect.stringContaining('aria-checked="true"'))
  expect(screen.queryByLabelText("Enable kimi-for-coding")).toBeNull()
  expect(
    screen.queryByText(
      "Service defaults shown below. Account access has not been checked.",
    ),
  ).toBeNull()
  expect(
    screen.queryByRole("button", { name: /Load models|Refresh models/ }),
  ).toBeNull()
  await user.clear(screen.getByLabelText("API key"))
  expect(screen.queryByLabelText("Enable Account coder")).toBeNull()
  expect(
    screen.queryByRole("button", { name: /Load models|Refresh models/ }),
  ).toBeNull()
})

it("retries failed discovery and distinguishes an empty account catalog from service defaults", async () => {
  let attempts = 0
  request.mockImplementation(async (method) => {
    if (method !== "provider/configuration/models")
      return { providers: [], presets: [preset] }
    attempts++
    if (attempts === 1) throw new Error("Catalog temporarily unavailable")
    return attempts === 2 ? [] : [{ id: "account-recovered" }]
  })
  const user = userEvent.setup()
  await openAccountSettings()
  await user.click(await screen.findByRole("button", { name: "DeepSeek" }))
  await user.click(screen.getByText("Model defaults (optional)"))
  await user.type(screen.getByLabelText("API key"), "test-account-key")
  await screen.findByText("Catalog temporarily unavailable")
  await user.click(screen.getByRole("button", { name: "Retry models" }))
  await screen.findByText(
    "No chat models returned by this account. Check account access or add a model ID.",
  )
  expect(screen.queryByLabelText("Enable DeepSeek Chat")).toBeNull()
  expect(screen.queryByText("Catalog temporarily unavailable")).toBeNull()
  expect(
    screen.queryByRole("button", { name: /Refresh models|Retry models/ }),
  ).toBeNull()
  await user.type(screen.getByLabelText("API key"), "-updated")
  await screen.findByRole("switch", { name: "Enable account-recovered" })
})
