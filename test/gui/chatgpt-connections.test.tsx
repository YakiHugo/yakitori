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
import { ChatGPTConnections } from "../../src/gui/components/chatgpt-connections.tsx"
import { ModelSelector } from "../../src/gui/components/model-selector.tsx"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import type { ChatGPTConnectionState } from "../../src/server/chatgpt-connections.ts"

const { request, changes, loadProviders } = vi.hoisted(() => ({
  request:
    vi.fn<
      (method: string, params: Record<string, unknown>) => Promise<unknown>
    >(),
  changes: new Set<() => void>(),
  loadProviders: vi.fn<() => Promise<void>>(),
}))
vi.mock("../../src/gui/lib/rpc-client.ts", () => ({
  getAppRpcClient: () => ({
    request,
    subscribeToProviderChanges: (listener: () => void) => {
      changes.add(listener)
      return () => changes.delete(listener)
    },
  }),
}))
const empty: ChatGPTConnectionState = { accounts: [], welcomeRequired: false }
const account = {
  id: "profile-personal",
  providerId: "chatgpt-profile-personal",
  label: "Personal",
  email: "same@example.test",
  state: "connected" as const,
}
const waiting: ChatGPTConnectionState = {
  ...empty,
  attempt: { id: "attempt-one", state: "waiting" },
}
let state: ChatGPTConnectionState
beforeEach(() => {
  state = empty
  request.mockReset().mockImplementation(async (method) => {
    if (method === "chatgpt/read") return state
    if (method === "chatgpt/signIn") {
      state = waiting
      return state
    }
    if (method === "chatgpt/cancel") {
      state = { ...empty, attempt: { id: "attempt-one", state: "cancelled" } }
      return state
    }
    throw new Error(`Unexpected RPC ${method}`)
  })
  loadProviders.mockReset().mockResolvedValue()
  useAppStore.setState({ ...createInitialAppState(), loadProviders })
})
afterEach(() => {
  cleanup()
  changes.clear()
  vi.useRealTimers()
})
async function notify() {
  await act(async () => {
    for (const listener of changes) listener()
  })
}

it("starts sign-in once and cancels the exact attempt on dismissal without rendering auth data", async () => {
  const user = userEvent.setup()
  render(<ChatGPTConnections apiBase="http://localhost:4100" active />)
  const button = await screen.findByRole("button", {
    name: "Continue with ChatGPT",
  })
  fireEvent.click(button)
  fireEvent.click(button)
  await screen.findByText("Waiting for sign-in in your system browser…")
  expect(
    request.mock.calls.filter(([method]) => method === "chatgpt/signIn"),
  ).toHaveLength(1)
  expect(request).toHaveBeenCalledWith("chatgpt/signIn", {})
  expect(screen.queryByRole("link", { name: /sign.in/i })).toBeNull()
  await user.click(screen.getByRole("button", { name: "Close" }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("chatgpt/cancel", {
      attemptId: "attempt-one",
    }),
  )
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
})

it("keeps sign-in open when the opening double-click lands on the new native backdrop", async () => {
  const user = userEvent.setup()
  render(<ChatGPTConnections apiBase="http://localhost:4100" active />)
  await user.click(
    await screen.findByRole("button", { name: "Continue with ChatGPT" }),
  )
  const dialog = await screen.findByRole("dialog", { name: "Connect ChatGPT" })
  // Chromium retargets the second click to the modal backdrop, outside its box.
  fireEvent.click(dialog, { clientX: -1, clientY: -1, detail: 2 })
  expect(
    await screen.findByText("Waiting for sign-in in your system browser…"),
  ).toBeDefined()
  expect(
    request.mock.calls.filter(([method]) => method === "chatgpt/signIn"),
  ).toHaveLength(1)
  expect(
    request.mock.calls.some(([method]) => method === "chatgpt/cancel"),
  ).toBe(false)
  // A fresh, deliberate backdrop click still cancels the exact active attempt.
  fireEvent.click(dialog, { clientX: -1, clientY: -1, detail: 1 })
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("chatgpt/cancel", {
      attemptId: "attempt-one",
    }),
  )
  expect(screen.queryByRole("dialog")).toBeNull()
})

it("cancels a browser launch that resolves after its panel was closed", async () => {
  let finish: ((value: ChatGPTConnectionState) => void) | undefined
  request.mockImplementation(async (method) => {
    if (method === "chatgpt/read") return empty
    if (method === "chatgpt/signIn")
      return new Promise<ChatGPTConnectionState>((resolve) => {
        finish = resolve
      })
    if (method === "chatgpt/cancel") return empty
    throw new Error(method)
  })
  const user = userEvent.setup()
  render(<ChatGPTConnections apiBase="http://localhost:4100" active />)
  await user.click(
    await screen.findByRole("button", { name: "Continue with ChatGPT" }),
  )
  await user.click(screen.getByRole("button", { name: "Cancel sign-in" }))
  expect(screen.queryByRole("dialog")).toBeNull()
  await act(async () => finish?.(waiting))
  expect(request).toHaveBeenCalledWith("chatgpt/cancel", {
    attemptId: "attempt-one",
  })
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(
    screen.queryByText("Waiting for sign-in in your system browser…"),
  ).toBeNull()
})

it("cancels on navigation away without cancelling twice on unmount", async () => {
  const user = userEvent.setup()
  const view = render(
    <ChatGPTConnections apiBase="http://localhost:4100" active />,
  )
  await user.click(
    await screen.findByRole("button", { name: "Continue with ChatGPT" }),
  )
  await screen.findByText("Waiting for sign-in in your system browser…")
  view.rerender(
    <ChatGPTConnections apiBase="http://localhost:4100" active={false} />,
  )
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("chatgpt/cancel", {
      attemptId: "attempt-one",
    }),
  )
  expect(screen.queryByRole("dialog")).toBeNull()
  view.unmount()
  expect(
    request.mock.calls.filter(([method]) => method === "chatgpt/cancel"),
  ).toHaveLength(1)
})

it("keeps saved accounts with matching emails distinct and reconnects the chosen registration", async () => {
  state = {
    accounts: [
      account,
      {
        ...account,
        id: "profile-work",
        providerId: "chatgpt-profile-work",
        label: "Work",
        state: "identity_only",
      },
    ],
    welcomeRequired: false,
  }
  const user = userEvent.setup()
  render(<ChatGPTConnections apiBase="http://localhost:4100" active />)
  await screen.findByText("Personal")
  expect(screen.getByText("Work")).toBeDefined()
  expect(screen.getAllByText("same@example.test")).toHaveLength(2)
  expect(screen.getByText("Signed in · plan usage not enabled")).toBeDefined()
  await user.click(
    screen.getByRole("button", { name: "Enable plan usage for Work" }),
  )
  expect(request).toHaveBeenCalledWith("chatgpt/signIn", {
    accountId: "profile-work",
  })
})

it("adds a labeled account without reusing a saved registration", async () => {
  state = {
    accounts: [account],
    welcomeRequired: false,
    attempt: { id: "old", state: "succeeded" },
  }
  const user = userEvent.setup()
  render(<ChatGPTConnections apiBase="http://localhost:4100" active />)
  await user.click(await screen.findByRole("button", { name: "Add account" }))
  await user.type(
    screen.getByRole("textbox", { name: "Account label" }),
    "Research",
  )
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Continue with ChatGPT",
    }),
  )
  expect(request).toHaveBeenCalledWith("chatgpt/signIn", { label: "Research" })
})

it("keeps declined plan permission as identity-only and never shows the plan welcome", async () => {
  const user = userEvent.setup()
  render(<ChatGPTConnections apiBase="http://localhost:4100" active />)
  await user.click(
    await screen.findByRole("button", { name: "Continue with ChatGPT" }),
  )
  state = {
    accounts: [{ ...account, state: "identity_only" }],
    attempt: { id: "attempt-one", state: "identity_only" },
    welcomeRequired: false,
  }
  await notify()
  expect(
    await screen.findByText("Signed in. ChatGPT plan usage wasn’t enabled."),
  ).toBeDefined()
  expect(
    screen.queryByRole("dialog", { name: "You’re using your ChatGPT plan" }),
  ).toBeNull()
  await waitFor(() => expect(loadProviders).toHaveBeenCalledOnce())
})

it("acknowledges the first plan welcome once and preserves that state across later sign-ins", async () => {
  const user = userEvent.setup()
  request.mockImplementation(async (method) => {
    if (method === "chatgpt/read") return state
    if (method === "chatgpt/signIn") return waiting
    if (method === "chatgpt/acknowledge") {
      state = { ...state, welcomeRequired: false }
      return state
    }
    if (method === "chatgpt/cancel") return empty
    throw new Error(method)
  })
  const view = render(
    <ChatGPTConnections apiBase="http://localhost:4100" active />,
  )
  await user.click(
    await screen.findByRole("button", { name: "Continue with ChatGPT" }),
  )
  state = {
    accounts: [account],
    attempt: { id: "attempt-one", state: "succeeded" },
    welcomeRequired: true,
  }
  await notify()
  const welcome = await screen.findByRole("dialog", {
    name: "You’re using your ChatGPT plan",
  })
  await user.click(within(welcome).getByRole("button", { name: "Got it" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  expect(
    request.mock.calls.filter(([method]) => method === "chatgpt/acknowledge"),
  ).toHaveLength(1)
  view.unmount()
  render(<ChatGPTConnections apiBase="http://localhost:4100" active />)
  await screen.findByText("Personal")
  expect(screen.queryByRole("dialog")).toBeNull()
})

it("discloses unconfirmed remote revocation after local signout with a usage-settings link", async () => {
  state = { accounts: [account], welcomeRequired: false }
  request.mockImplementation(async (method) => {
    if (method === "chatgpt/read") return state
    if (method === "chatgpt/signOut")
      return {
        accounts: [
          { ...account, state: "signed_out", remoteRevocation: "unconfirmed" },
        ],
        welcomeRequired: false,
      }
    throw new Error(method)
  })
  const user = userEvent.setup()
  render(<ChatGPTConnections apiBase="http://localhost:4100" active />)
  await user.click(
    await screen.findByRole("button", { name: "Sign out Personal" }),
  )
  expect(request).toHaveBeenCalledWith("chatgpt/signOut", {
    accountId: "profile-personal",
  })
  expect(
    await screen.findByText(/Remote revocation wasn’t confirmed/),
  ).toBeDefined()
  expect(
    screen.getByRole("link", { name: "Manage usage ↗" }).getAttribute("href"),
  ).toBe("https://chatgpt.com/settings/usage")
  expect(screen.queryByRole("button", { name: "Sign out Personal" })).toBeNull()
})

it("ignores an older read after a newer sign-out action", async () => {
  state = { accounts: [account], welcomeRequired: false }
  const user = userEvent.setup()
  render(<ChatGPTConnections apiBase="http://localhost:4100" active />)
  await screen.findByText("Personal")
  let staleRead: ((value: ChatGPTConnectionState) => void) | undefined
  request.mockImplementation(async (method) => {
    if (method === "chatgpt/read")
      return new Promise<ChatGPTConnectionState>((resolve) => {
        staleRead = resolve
      })
    if (method === "chatgpt/signOut")
      return {
        accounts: [{ ...account, state: "signed_out" }],
        welcomeRequired: false,
      }
    throw new Error(method)
  })
  await notify()
  await user.click(screen.getByRole("button", { name: "Sign out Personal" }))
  await screen.findByText("Signed out on this device")
  await act(async () => staleRead?.(state))
  expect(screen.getByText("Signed out on this device")).toBeDefined()
})

it("shows ChatGPT plan use for the selected account and removes it for other providers", async () => {
  const model = {
    id: "test-model",
    instructionProfileId: "test",
    displayName: "Test model",
  }
  useAppStore.setState({
    providers: [
      {
        name: "chatgpt-profile-personal",
        displayName: "ChatGPT · Personal",
        models: [model],
      },
      { name: "codex", models: [model] },
    ],
    defaultProvider: "chatgpt-profile-personal",
    defaultModel: "test-model",
  })
  const { rerender } = render(
    <ModelSelector
      selection={{ provider: "chatgpt-profile-personal", model: "test-model" }}
      onChange={() => {}}
    />,
  )
  expect(screen.getByText("Using ChatGPT plan")).toBeDefined()
  const user = userEvent.setup()
  await user.click(
    screen.getByRole("button", { name: "Select model and effort" }),
  )
  expect(screen.getByText("ChatGPT · Personal")).toBeDefined()
  rerender(
    <ModelSelector
      selection={{ provider: "codex", model: "test-model" }}
      onChange={() => {}}
    />,
  )
  expect(screen.queryByText("Using ChatGPT plan")).toBeNull()
})

it("attempts cancellation after an unresolved launch unmounts and reports failure visibly", async () => {
  let finish: ((value: ChatGPTConnectionState) => void) | undefined
  request.mockImplementation(async (method) => {
    if (method === "chatgpt/read") return empty
    if (method === "chatgpt/signIn")
      return new Promise<ChatGPTConnectionState>((resolve) => {
        finish = resolve
      })
    if (method === "chatgpt/cancel")
      throw new Error("fake connection interrupted")
    throw new Error(method)
  })
  const user = userEvent.setup()
  const view = render(
    <ChatGPTConnections apiBase="http://localhost:4100" active />,
  )
  await user.click(
    await screen.findByRole("button", { name: "Continue with ChatGPT" }),
  )
  view.unmount()
  await act(async () => finish?.(waiting))
  expect(request).toHaveBeenCalledWith("chatgpt/cancel", {
    attemptId: "attempt-one",
  })
  expect(useAppStore.getState().message).toBe(
    "Could not confirm ChatGPT sign-in cancellation. Reopen Providers settings to cancel it.",
  )
})

it("allows cancelling again after a failed cancellation and blocks another sign-in", async () => {
  const user = userEvent.setup()
  render(<ChatGPTConnections apiBase="http://localhost:4100" active />)
  await user.click(
    await screen.findByRole("button", { name: "Continue with ChatGPT" }),
  )
  await screen.findByText("Waiting for sign-in in your system browser…")
  request.mockImplementation(async (method) => {
    if (method === "chatgpt/cancel") throw new Error("interrupted")
    if (method === "chatgpt/read") return waiting
    throw new Error(method)
  })
  await user.click(screen.getByRole("button", { name: "Cancel sign-in" }))
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Could not confirm sign-in cancellation. Cancel again before starting another sign-in.",
  )
  expect(
    screen.getByRole("button", { name: "Continue with ChatGPT" }),
  ).toHaveProperty("disabled", true)
  request.mockImplementation(async () => empty)
  await user.click(screen.getByRole("button", { name: "Cancel sign-in" }))
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull(),
  )
  expect(
    request.mock.calls.filter(([method]) => method === "chatgpt/cancel"),
  ).toHaveLength(2)
  expect(screen.queryByRole("alert")).toBeNull()
})

it("rejects duplicate account labels before starting authentication", async () => {
  state = { accounts: [account], welcomeRequired: false }
  const user = userEvent.setup()
  render(<ChatGPTConnections apiBase="http://localhost:4100" active />)
  await user.click(await screen.findByRole("button", { name: "Add account" }))
  await user.type(
    screen.getByRole("textbox", { name: "Account label" }),
    "Personal",
  )
  expect(screen.getByRole("alert").textContent).toBe(
    "Choose a different label for this connection.",
  )
  expect(
    screen.getByRole("button", { name: "Continue with ChatGPT" }),
  ).toHaveProperty("disabled", true)
  expect(
    request.mock.calls.some(([method]) => method === "chatgpt/signIn"),
  ).toBe(false)
})

it("keeps welcome acknowledgement retryable after dismissing during a failed save", async () => {
  state = { accounts: [account], welcomeRequired: true }
  request.mockImplementation(async (method) => {
    if (method === "chatgpt/read") return state
    if (method === "chatgpt/acknowledge") throw new Error("offline")
    throw new Error(method)
  })
  const user = userEvent.setup()
  render(<ChatGPTConnections apiBase="http://localhost:4100" active />)
  await screen.findByRole("dialog", { name: "You’re using your ChatGPT plan" })
  await user.click(screen.getByRole("button", { name: "Close" }))
  const error = await screen.findByRole("alert")
  expect(error.textContent).toBe(
    "Could not update the ChatGPT connection. Try again.",
  )
  request.mockImplementation(async () => ({ ...state, welcomeRequired: false }))
  await user.click(screen.getByRole("button", { name: "Got it" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
})

it("polls waiting attempts without overlapping slow reads", async () => {
  vi.useFakeTimers()
  const view = render(
    <ChatGPTConnections apiBase="http://localhost:4100" active />,
  )
  await act(async () => {})
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Continue with ChatGPT" }),
    )
  })
  let finish: ((value: ChatGPTConnectionState) => void) | undefined
  request.mockImplementation(async (method) => {
    if (method === "chatgpt/read")
      return new Promise<ChatGPTConnectionState>((resolve) => {
        finish = resolve
      })
    if (method === "chatgpt/cancel") return empty
    throw new Error(method)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000)
  })
  expect(
    request.mock.calls.filter(([method]) => method === "chatgpt/read"),
  ).toHaveLength(2)
  await act(async () =>
    finish?.({
      accounts: [account],
      welcomeRequired: true,
      attempt: { id: "attempt-one", state: "succeeded" },
    }),
  )
  expect(
    screen.getByRole("dialog", { name: "You’re using your ChatGPT plan" }),
  ).toBeDefined()
  view.unmount()
})

it("retries a failed reconnect against the same saved registration", async () => {
  state = { accounts: [account], welcomeRequired: false }
  request.mockImplementation(async (method) => {
    if (method === "chatgpt/read") return state
    if (method === "chatgpt/signIn") throw new Error("browser could not open")
    throw new Error(method)
  })
  const user = userEvent.setup()
  render(<ChatGPTConnections apiBase="http://localhost:4100" active />)
  await user.click(
    await screen.findByRole("button", { name: "Reconnect Personal" }),
  )
  await screen.findByRole("alert")
  expect(screen.queryByRole("textbox", { name: "Account label" })).toBeNull()
  await user.click(
    screen.getByRole("button", { name: "Continue with ChatGPT" }),
  )
  expect(
    request.mock.calls.filter(([method]) => method === "chatgpt/signIn"),
  ).toEqual([
    ["chatgpt/signIn", { accountId: "profile-personal" }],
    ["chatgpt/signIn", { accountId: "profile-personal" }],
  ])
})

it("shows an account catalog failure while keeping other model choices available", async () => {
  useAppStore.setState({
    providers: [
      {
        name: "chatgpt-personal",
        displayName: "ChatGPT · Personal",
        models: [],
        catalogError:
          "Could not load this account’s models. Reconnect in Providers settings.",
      },
      {
        name: "other",
        models: [
          {
            id: "working",
            displayName: "Working model",
            instructionProfileId: "test",
          },
        ],
      },
    ],
    defaultProvider: "other",
    defaultModel: "working",
  })
  const user = userEvent.setup()
  render(<ModelSelector />)
  await user.click(
    screen.getByRole("button", { name: "Select model and effort" }),
  )
  expect(screen.getByText("ChatGPT · Personal")).toBeDefined()
  expect(screen.getByRole("status").textContent).toContain(
    "Could not load this account’s models",
  )
  expect(screen.getByRole("button", { name: "Working model" })).toBeDefined()
  await user.click(screen.getByRole("button", { name: "Manage connection" }))
  expect(useAppStore.getState().settingsSection).toBe("providers")
})

it("resynchronizes signout and its revocation warning after navigating away during the request", async () => {
  state = { accounts: [account], welcomeRequired: false }
  let finish: ((value: ChatGPTConnectionState) => void) | undefined
  request.mockImplementation(async (method) => {
    if (method === "chatgpt/read") return state
    if (method === "chatgpt/signOut")
      return new Promise<ChatGPTConnectionState>((resolve) => {
        finish = resolve
      })
    throw new Error(method)
  })
  const user = userEvent.setup()
  const view = render(
    <ChatGPTConnections apiBase="http://localhost:4100" active />,
  )
  await user.click(
    await screen.findByRole("button", { name: "Sign out Personal" }),
  )
  view.rerender(
    <ChatGPTConnections apiBase="http://localhost:4100" active={false} />,
  )
  state = {
    accounts: [
      { ...account, state: "signed_out", remoteRevocation: "unconfirmed" },
    ],
    welcomeRequired: false,
  }
  await notify()
  await act(async () => finish?.(state))
  view.rerender(<ChatGPTConnections apiBase="http://localhost:4100" active />)
  expect(
    await screen.findByText(/Remote revocation wasn’t confirmed/),
  ).toBeDefined()
  expect(screen.queryByRole("button", { name: "Sign out Personal" })).toBeNull()
})

it("restarts a dismissed initial read when the settings section becomes active again", async () => {
  let finish: ((value: ChatGPTConnectionState) => void) | undefined
  let reads = 0
  request.mockImplementation(async (method) => {
    if (method === "chatgpt/read") {
      if (++reads === 1)
        return new Promise<ChatGPTConnectionState>((resolve) => {
          finish = resolve
        })
      return empty
    }
    throw new Error(method)
  })
  const view = render(
    <ChatGPTConnections apiBase="http://localhost:4100" active />,
  )
  view.rerender(
    <ChatGPTConnections apiBase="http://localhost:4100" active={false} />,
  )
  await act(async () => finish?.(empty))
  view.rerender(<ChatGPTConnections apiBase="http://localhost:4100" active />)
  expect(
    await screen.findByRole("button", { name: "Continue with ChatGPT" }),
  ).toBeDefined()
})

it("retries a newly named failed attempt against its persisted registration", async () => {
  state = { accounts: [account], welcomeRequired: false }
  request.mockImplementation(async (method) => {
    if (method === "chatgpt/read") return state
    if (method === "chatgpt/signIn") {
      state = {
        accounts: [
          account,
          {
            ...account,
            id: "profile-research",
            providerId: "chatgpt-research",
            label: "Research",
            state: "signed_out",
          },
        ],
        welcomeRequired: false,
        attempt: {
          id: "research-attempt",
          accountId: "profile-research",
          state: "failed",
        },
      }
      return state
    }
    throw new Error(method)
  })
  const user = userEvent.setup()
  render(<ChatGPTConnections apiBase="http://localhost:4100" active />)
  await user.click(await screen.findByRole("button", { name: "Add account" }))
  await user.type(
    screen.getByRole("textbox", { name: "Account label" }),
    "Research",
  )
  await user.click(
    screen.getByRole("button", { name: "Continue with ChatGPT" }),
  )
  await screen.findByText("ChatGPT sign-in did not finish. Try again.")
  await user.click(
    screen.getByRole("button", { name: "Continue with ChatGPT" }),
  )
  expect(
    request.mock.calls.filter(([method]) => method === "chatgpt/signIn"),
  ).toEqual([
    ["chatgpt/signIn", { label: "Research" }],
    ["chatgpt/signIn", { accountId: "profile-research" }],
  ])
})

it("opens Manage usage through the desktop bridge without navigating the renderer", async () => {
  const openUrl = vi.fn(async () => {})
  Object.defineProperty(window, "yakitoriDesktop", {
    configurable: true,
    value: { openUrl },
  })
  try {
    const user = userEvent.setup()
    render(<ChatGPTConnections apiBase="http://localhost:4100" active />)
    await screen.findByRole("button", { name: "Continue with ChatGPT" })
    const original = window.location.href
    await user.click(screen.getByRole("link", { name: "Manage usage ↗" }))
    expect(openUrl).toHaveBeenCalledWith({
      url: "https://chatgpt.com/settings/usage",
    })
    expect(window.location.href).toBe(original)
  } finally {
    Object.defineProperty(window, "yakitoriDesktop", {
      configurable: true,
      value: undefined,
    })
  }
})

it("reconciles a terminal sign-in after early dismissal without reopening the dialog", async () => {
  state = {
    accounts: [{ ...account, state: "signed_out" }],
    welcomeRequired: false,
  }
  let finish: ((value: ChatGPTConnectionState) => void) | undefined
  request.mockImplementation(async (method) => {
    if (method === "chatgpt/read") return state
    if (method === "chatgpt/signIn")
      return new Promise<ChatGPTConnectionState>((resolve) => {
        finish = resolve
      })
    throw new Error(method)
  })
  const user = userEvent.setup()
  render(<ChatGPTConnections apiBase="http://localhost:4100" active />)
  await user.click(
    await screen.findByRole("button", { name: "Reconnect Personal" }),
  )
  await user.click(screen.getByRole("button", { name: "Cancel sign-in" }))
  state = {
    accounts: [account],
    welcomeRequired: false,
    attempt: { id: "finished", accountId: account.id, state: "succeeded" },
  }
  await notify()
  await act(async () => finish?.(state))
  expect(await screen.findByText("ChatGPT plan usage enabled")).toBeDefined()
  expect(screen.queryByRole("dialog")).toBeNull()
})

it("ignores a failed browser launch after the sign-in was dismissed", async () => {
  let rejectLaunch: ((error: Error) => void) | undefined
  request.mockImplementation(async (method) => {
    if (method === "chatgpt/read") return empty
    if (method === "chatgpt/signIn")
      return new Promise((_resolve, reject) => {
        rejectLaunch = reject
      })
    throw new Error(method)
  })
  const user = userEvent.setup()
  render(<ChatGPTConnections apiBase="http://localhost:4100" active />)
  await user.click(
    await screen.findByRole("button", { name: "Continue with ChatGPT" }),
  )
  await user.click(screen.getByRole("button", { name: "Cancel sign-in" }))
  await act(async () => rejectLaunch?.(new Error("Browser launch failed")))
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(screen.queryByRole("alert")).toBeNull()
  expect(
    screen.getByRole("button", { name: "Continue with ChatGPT" }),
  ).toHaveProperty("disabled", false)
})
