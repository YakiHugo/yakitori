// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createEventEnvelope, EventType } from "../../src/index.ts"
import { Composer } from "../../src/gui/components/composer.tsx"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"

beforeEach(() => {
  useAppStore.setState(createInitialAppState())
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      const userPreference = JSON.parse(String(init?.body ?? "{}")) as unknown
      return new Response(JSON.stringify({ userPreference }), { status: 200 })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("composer", () => {
  it("sends the trimmed draft on Enter", async () => {
    const user = userEvent.setup()
    const admitInput = vi.fn((_text: string) => Promise.resolve())
    useAppStore.setState({
      admitInput,
      selection: { revision: 1, sessionId: "session_1" },
      promptDraft: "  hello mate  ",
    })
    render(<Composer />)

    const textarea = screen.getByRole("textbox")
    await user.click(textarea)
    await user.keyboard("{Enter}")

    expect(admitInput).toHaveBeenCalledTimes(1)
    expect(admitInput).toHaveBeenCalledWith("hello mate")
  })

  it("does not send on Shift+Enter", async () => {
    const user = userEvent.setup()
    const admitInput = vi.fn((_text: string) => Promise.resolve())
    useAppStore.setState({
      admitInput,
      selection: { revision: 1, sessionId: "session_1" },
      promptDraft: "hello",
    })
    render(<Composer />)

    const textarea = screen.getByRole("textbox")
    await user.click(textarea)
    await user.keyboard("{Shift>}{Enter}{/Shift}")

    expect(admitInput).not.toHaveBeenCalled()
  })

  it("keeps the send button disabled for an empty draft", () => {
    useAppStore.setState({
      selection: { revision: 1, sessionId: "session_1" },
      promptDraft: "   ",
    })
    render(<Composer />)

    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty(
      "disabled",
      true,
    )
  })

  it("keeps sending disabled until an old Session model is restored", () => {
    useAppStore.setState({
      selection: { revision: 1, sessionId: "session_1" },
      promptDraft: "hello",
      modelSelectionReady: false,
    })
    render(<Composer />)

    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty(
      "disabled",
      true,
    )
  })
})

describe("model selector", () => {
  function selectModelState() {
    return {
      selection: { revision: 1, sessionId: "session_1" },
      providers: [
        {
          name: "openai",
          defaultModel: "gpt-5.1-codex",
          models: [
            {
              id: "gpt-5.1-codex",
              displayName: "GPT 5.1 Codex",
              family: "gpt",
              efforts: ["low", "medium", "high"],
              speeds: ["standard", "fast"],
            },
            {
              id: "gpt-5",
              displayName: "GPT-5",
              family: "gpt",
              efforts: ["low", "medium", "high"],
              speeds: ["standard", "fast"],
            },
          ],
        },
        {
          name: "codex",
          models: [
            {
              id: "gpt-5.6-sol",
              displayName: "GPT-5.6 Sol",
              family: "gpt",
              efforts: ["low", "medium", "high", "xhigh"],
              speeds: ["standard", "fast"],
            },
          ],
        },
        {
          name: "kimi",
          models: [
            {
              id: "kimi-for-coding",
              displayName: "K2.7 Coding",
              family: "kimi",
            },
            {
              id: "k3",
              displayName: "K3",
              family: "kimi",
              efforts: ["low", "high", "max"],
            },
          ],
        },
        {
          name: "anthropic",
          models: [
            {
              id: "claude-sonnet-4-6",
              displayName: "Claude Sonnet 4.6",
              family: "anthropic",
              efforts: ["low", "medium", "high"],
            },
          ],
        },
        {
          name: "grok",
          models: [
            {
              id: "grok-4.20-non-reasoning",
              displayName: "Grok 4.20 Non-Reasoning",
              family: "default",
            },
          ],
        },
      ],
      defaultProvider: "openai",
      defaultModel: "gpt-5.1-codex",
    }
  }

  it("labels the pill with session current instead of the last started turn", () => {
    const started = createEventEnvelope({
      sessionId: "session_1",
      seq: 2,
      event: {
        type: EventType.TurnStarted,
        data: {
          turnId: "turn_1",
          inputId: "input_1",
          executionContext: {
            mateId: "mate_1",
            mateRevisionId: "revision_1",
            provider: "openai",
            model: "gpt-5.1-codex",
            effort: "high",
            workingDirectory: "/p/a",
            enabledTools: [],
            approvalPolicy: "on-request",
            limits: {
              modelCallsPerTurn: 10,
              toolCallsPerTurn: 10,
              modelVisibleMessageBlocks: 10,
              modelVisibleContextBytes: 10,
              modelVisibleToolResultBytes: 10,
              modelVisibleToolResultLines: 10,
              assistantResponseBytes: 10,
            },
          },
        },
      },
    })
    useAppStore.setState({
      ...selectModelState(),
      events: [started],
      modelSelections: {
        session_1: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          effort: "low",
        },
      },
    })
    render(<Composer />)

    expect(
      screen.getByRole("button", { name: "Select model" }).textContent,
    ).toBe("Claude Sonnet 4.6 · low")
  })

  it("groups model rows by provider and offers efforts for reasoning models", async () => {
    const user = userEvent.setup()
    window.localStorage.clear()
    useAppStore.setState({ ...selectModelState(), modelSelections: {} })
    render(<Composer />)

    await user.click(screen.getByRole("button", { name: "Select model" }))

    expect(screen.getByText("模型")).toBeDefined()
    expect(screen.getByText("openai")).toBeDefined()
    expect(screen.getByText("anthropic")).toBeDefined()
    expect(screen.getByRole("button", { name: "GPT 5.1 Codex" })).toBeDefined()
    expect(
      screen.getByRole("button", { name: "Claude Sonnet 4.6" }),
    ).toBeDefined()
    expect(
      screen.getByRole("button", { name: "Grok 4.20 Non-Reasoning" }),
    ).toBeDefined()

    // The effective default model is a reasoning model: effort rows show.
    expect(screen.getByText("推理强度")).toBeDefined()
    expect(screen.getByRole("button", { name: "low" })).toBeDefined()
    expect(screen.getByRole("button", { name: "medium" })).toBeDefined()
    expect(screen.getByRole("button", { name: "high" })).toBeDefined()

    // And it has speed tiers.
    expect(screen.getByText("速度")).toBeDefined()
    expect(screen.getByRole("button", { name: "标准" })).toBeDefined()
    expect(screen.getByRole("button", { name: "快速" })).toBeDefined()
  })

  it("persists a clicked model per session, keeping a supported effort", async () => {
    const user = userEvent.setup()
    window.localStorage.clear()
    useAppStore.setState({
      ...selectModelState(),
      modelSelections: {
        session_1: { provider: "openai", model: "gpt-5", effort: "low" },
      },
    })
    render(<Composer />)

    await user.click(screen.getByRole("button", { name: "Select model" }))
    await user.click(screen.getByRole("button", { name: "GPT 5.1 Codex" }))

    expect(useAppStore.getState().modelSelections).toEqual({
      session_1: { provider: "openai", model: "gpt-5.1-codex", effort: "low" },
    })
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        expect.stringMatching(/\/user-preference$/),
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            provider: "openai",
            model: "gpt-5.1-codex",
            effort: "low",
          }),
        }),
      )
    })
    expect(
      JSON.parse(
        window.localStorage.getItem("yakitori.modelSelections") ?? "{}",
      ),
    ).toEqual({
      session_1: { provider: "openai", model: "gpt-5.1-codex", effort: "low" },
    })

    // Claude offers the same effort levels, so the pinned effort survives.
    await user.click(screen.getByRole("button", { name: "Select model" }))
    await user.click(screen.getByRole("button", { name: "Claude Sonnet 4.6" }))

    expect(useAppStore.getState().modelSelections).toEqual({
      session_1: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        effort: "low",
      },
    })

    // K3 does not offer OpenAI's "medium", so switching drops that effort.
    useAppStore.setState({
      modelSelections: {
        session_1: {
          provider: "openai",
          model: "gpt-5.1-codex",
          effort: "medium",
        },
      },
    })
    await user.click(screen.getByRole("button", { name: "Select model" }))
    await user.click(screen.getByRole("button", { name: "K3" }))

    expect(useAppStore.getState().modelSelections).toEqual({
      session_1: { provider: "kimi", model: "k3" },
    })
  })

  it("pins an effort for the effective model and clears it with Default", async () => {
    const user = userEvent.setup()
    window.localStorage.clear()
    useAppStore.setState({ ...selectModelState(), modelSelections: {} })
    render(<Composer />)

    await user.click(screen.getByRole("button", { name: "Select model" }))
    await user.click(screen.getByRole("button", { name: "high" }))

    expect(useAppStore.getState().modelSelections).toEqual({
      session_1: { provider: "openai", model: "gpt-5.1-codex", effort: "high" },
    })
    expect(
      screen.getByRole("button", { name: "Select model" }).textContent,
    ).toBe("GPT 5.1 Codex · high")

    await user.click(screen.getByRole("button", { name: "Select model" }))
    // The effort section Default row clears only the effort, keeping the model.
    await user.click(screen.getByRole("button", { name: "Default" }))

    expect(useAppStore.getState().modelSelections).toEqual({
      session_1: { provider: "openai", model: "gpt-5.1-codex" },
    })
  })

  it("hides the effort section when the effective model offers none", async () => {
    const user = userEvent.setup()
    window.localStorage.clear()
    useAppStore.setState({
      ...selectModelState(),
      modelSelections: {
        session_1: { provider: "grok", model: "grok-4.20-non-reasoning" },
      },
    })
    render(<Composer />)

    await user.click(screen.getByRole("button", { name: "Select model" }))

    expect(screen.queryByText("推理强度")).toBeNull()
    const selectedRow = screen.getByRole("button", {
      name: "Grok 4.20 Non-Reasoning",
    })
    expect(selectedRow.className).toContain("bg-accent")
    expect(selectedRow.querySelector("svg")).not.toBeNull()
  })

  it("keeps K2.7 thinking on without exposing K3 effort levels", async () => {
    const user = userEvent.setup()
    window.localStorage.clear()
    useAppStore.setState({
      ...selectModelState(),
      modelSelections: {
        session_1: { provider: "kimi", model: "kimi-for-coding" },
      },
    })
    render(<Composer />)

    await user.click(screen.getByRole("button", { name: "Select model" }))

    expect(screen.queryByText("推理强度")).toBeNull()
    expect(screen.queryByText("速度")).toBeNull()
  })

  it("pins and clears a speed tier for codex models", async () => {
    const user = userEvent.setup()
    window.localStorage.clear()
    useAppStore.setState({
      ...selectModelState(),
      modelSelections: {
        session_1: { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
      },
    })
    render(<Composer />)

    await user.click(screen.getByRole("button", { name: "Select model" }))
    await user.click(screen.getByRole("button", { name: "快速" }))

    // Picking a speed keeps the pinned effort.
    expect(useAppStore.getState().modelSelections).toEqual({
      session_1: {
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
        speed: "fast",
      },
    })
    expect(
      JSON.parse(
        window.localStorage.getItem("yakitori.modelSelections") ?? "{}",
      ),
    ).toEqual({
      session_1: {
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
        speed: "fast",
      },
    })

    await user.click(screen.getByRole("button", { name: "Select model" }))
    await user.click(screen.getByRole("button", { name: "标准" }))

    expect(useAppStore.getState().modelSelections).toEqual({
      session_1: { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
    })
  })

  it("checks the standard row for an explicit standard speed", async () => {
    const user = userEvent.setup()
    useAppStore.setState({
      ...selectModelState(),
      modelSelections: {
        session_1: {
          provider: "codex",
          model: "gpt-5.6-sol",
          speed: "standard",
        },
      },
    })
    render(<Composer />)

    await user.click(screen.getByRole("button", { name: "Select model" }))

    expect(
      screen.getByRole("button", { name: "标准" }).querySelector("svg"),
    ).not.toBeNull()
    expect(
      screen.getByRole("button", { name: "快速" }).querySelector("svg"),
    ).toBeNull()
  })

  it("hides the speed section for providers without tiers", async () => {
    const user = userEvent.setup()
    window.localStorage.clear()
    useAppStore.setState({
      ...selectModelState(),
      modelSelections: {
        session_1: { provider: "anthropic", model: "claude-sonnet-4-6" },
      },
    })
    render(<Composer />)

    await user.click(screen.getByRole("button", { name: "Select model" }))

    expect(screen.getByText("推理强度")).toBeDefined()
    expect(screen.queryByText("速度")).toBeNull()
  })

  it("checks the effective model row and offers no Default row", async () => {
    const user = userEvent.setup()
    window.localStorage.clear()
    useAppStore.setState({ ...selectModelState(), modelSelections: {} })
    render(<Composer />)

    await user.click(screen.getByRole("button", { name: "Select model" }))

    // No override: the configured default model row carries the check.
    expect(screen.queryByRole("button", { name: /^Default \(/ })).toBeNull()
    const defaultRow = screen.getByRole("button", { name: "GPT 5.1 Codex" })
    expect(defaultRow.querySelector("svg")).not.toBeNull()
    const otherRow = screen.getByRole("button", { name: "GPT-5" })
    expect(otherRow.querySelector("svg")).toBeNull()

    // An explicit selection moves the check to that row.
    await user.click(otherRow)
    await user.click(screen.getByRole("button", { name: "Select model" }))
    expect(
      screen.getByRole("button", { name: "GPT-5" }).querySelector("svg"),
    ).not.toBeNull()
    expect(
      screen
        .getByRole("button", { name: "GPT 5.1 Codex" })
        .querySelector("svg"),
    ).toBeNull()
  })
})
