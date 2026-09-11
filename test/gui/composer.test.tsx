// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Composer } from "../../src/gui/components/composer.tsx"
import {
  createExecutionViewState,
  reduceExecutionView,
} from "../../src/gui/execution-view.ts"
import { ApiRequestError } from "../../src/gui/lib/rpc-client.ts"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import { createEventEnvelope, EventType, InputRole } from "../../src/kernel/events.ts"
import { FakeRpcClient } from "./fake-rpc-client.ts"

const fakeRef = vi.hoisted(() => ({
  current: undefined as unknown as FakeRpcClient,
}))

vi.mock("../../src/gui/lib/rpc-client.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/gui/lib/rpc-client.ts")>()
  return {
    ...original,
    getAppRpcClient: () => fakeRef.current,
  }
})

beforeEach(() => {
  fakeRef.current = new FakeRpcClient()
  fakeRef.current.respond = (method, params) => {
    if (method === "userPreference/write") {
      return { userPreference: params }
    }
    throw new ApiRequestError("not found", "not_found")
  }
  useAppStore.setState(createInitialAppState())
  Object.defineProperty(window, "yakitoriDesktop", {
    configurable: true,
    value: {
      pickImages: vi.fn(async () => [draftImage("high")]),
      importImageFiles: vi.fn(async () => [draftImage("high")]),
      discardDraftImages: vi.fn(async () => {}),
      openFile: vi.fn(async () => {}),
      openUrl: vi.fn(async () => {}),
    },
  })
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
      selection: { sessionId: "session_1" },
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
      selection: { sessionId: "session_1" },
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
      selection: { sessionId: "session_1" },
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
      selection: { sessionId: "session_1" },
      promptDraft: "hello",
      restoringModelSelectionFor: "session_1",
    })
    render(<Composer />)

    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty(
      "disabled",
      true,
    )
  })

  it("shows an explicit sending state while admission is in flight", () => {
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      promptDraft: "hello",
      inFlightActions: new Set(["admit:session_1"]),
    })
    render(<Composer />)

    const button = screen.getByRole("button", { name: "Sending" })
    expect(button.textContent).toContain("Sending")
    expect(button).toHaveProperty("disabled", true)
  })

  it("attaches an image, selects original detail, and sends without text", async () => {
    const user = userEvent.setup()
    const admitInput = vi.fn(() => Promise.resolve())
    useAppStore.setState({
      admitInput,
      selection: { sessionId: "session_1" },
    })
    render(<Composer />)
    await user.click(screen.getByRole("button", { name: "Attach images" }))
    await waitFor(() => {
      expect(useAppStore.getState().promptAttachments).toHaveLength(1)
    })
    await user.click(
      screen.getByRole("button", {
        name: "Use original detail for screenshot.png",
      }),
    )
    await user.click(screen.getByRole("button", { name: "Send" }))

    expect(admitInput).toHaveBeenCalledWith("", [
      {
        name: "screenshot.png",
        mediaType: "image/png",
        detail: "original",
        sizeBytes: 9,
        file: {
          rolloutId: "session_1",
          path: "attachments/staging/draft_1/1.png",
        },
      },
    ])
  })

  it("explains and normalizes original detail for a model without that mode", async () => {
    const user = userEvent.setup()
    const admitInput = vi.fn(() => Promise.resolve())
    useAppStore.setState({
      admitInput,
      selection: { sessionId: "session_1" },
      defaultProvider: "kimi",
      defaultModel: "k3",
      providers: [
        {
          name: "kimi",
          models: [
            {
              id: "k3",
              instructionProfileId: "kimi",
              inputModalities: ["text", "image"],
              imageDetailModes: [],
            },
          ],
        },
      ],
      promptAttachments: [
        {
          name: "screenshot.png",
          mediaType: "image/png",
          detail: "original",
          sizeBytes: 9,
          file: {
            rolloutId: "session_1",
            path: "attachments/staging/draft_1/1.png",
          },
        },
      ],
    })
    render(<Composer />)

    expect(screen.getByText(/Original detail is unavailable/)).toBeDefined()
    expect(
      screen.getByRole("button", {
        name: "Original detail unavailable for screenshot.png",
      }),
    ).toHaveProperty("disabled", true)
    await user.click(screen.getByRole("button", { name: "Send" }))

    expect(admitInput).toHaveBeenCalledWith("", [
      expect.objectContaining({ detail: "high" }),
    ])
  })
})

function draftImage(detail: "high" | "original") {
  return {
    name: "screenshot.png",
    mediaType: "image/png" as const,
    detail,
    sizeBytes: 9,
    file: {
      rolloutId: "session_1",
      path: "attachments/staging/draft_1/1.png",
    },
  }
}

function executionWithHistory(...texts: readonly string[]) {
  return texts.reduce(
    (state, text, index) =>
      reduceExecutionView(state, {
        type: "durable",
        event: createEventEnvelope({
          sessionId: "session_1",
          seq: index + 1,
          event: {
            type: EventType.InputAdmitted,
            data: {
              requestId: `request_${index + 1}`,
              inputId: `input_${index + 1}`,
              role: InputRole.User,
              content: { kind: "text", text },
            },
          },
        }),
      }),
    createExecutionViewState(),
  )
}

describe("history navigation", () => {
  it("recalls admitted inputs with ArrowUp and restores the draft with ArrowDown", async () => {
    const user = userEvent.setup()
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      execution: executionWithHistory("first question", "second question"),
      promptDraft: "work in progress",
    })
    render(<Composer />)

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    await user.click(textarea)
    textarea.setSelectionRange(0, 0)
    await user.keyboard("{ArrowUp}")
    expect(useAppStore.getState().promptDraft).toBe("second question")
    await user.keyboard("{ArrowUp}")
    expect(useAppStore.getState().promptDraft).toBe("first question")
    // Already at the oldest entry: ArrowUp changes nothing.
    await user.keyboard("{ArrowUp}")
    expect(useAppStore.getState().promptDraft).toBe("first question")
    await user.keyboard("{ArrowDown}")
    expect(useAppStore.getState().promptDraft).toBe("second question")
    await user.keyboard("{ArrowDown}")
    expect(useAppStore.getState().promptDraft).toBe("work in progress")
  })

  it("keeps ArrowUp for cursor movement when the cursor is not at the start", async () => {
    const user = userEvent.setup()
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      execution: executionWithHistory("first question"),
      promptDraft: "hello",
    })
    render(<Composer />)

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    await user.click(textarea)
    textarea.setSelectionRange(2, 2)
    await user.keyboard("{ArrowUp}")

    expect(useAppStore.getState().promptDraft).toBe("hello")
  })

  it("treats an edit during recall as the new in-progress draft", async () => {
    const user = userEvent.setup()
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      execution: executionWithHistory("first question"),
      promptDraft: "work in progress",
    })
    render(<Composer />)

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    await user.click(textarea)
    textarea.setSelectionRange(0, 0)
    await user.keyboard("{ArrowUp}")
    expect(useAppStore.getState().promptDraft).toBe("first question")

    fireEvent.change(textarea, { target: { value: "edited" } })
    textarea.setSelectionRange(0, 0)
    await user.keyboard("{ArrowUp}")
    expect(useAppStore.getState().promptDraft).toBe("first question")
    await user.keyboard("{ArrowDown}")
    expect(useAppStore.getState().promptDraft).toBe("edited")
  })
})

describe("slash command menu", () => {
  it("executes the highlighted command on Enter and clears the draft", async () => {
    const user = userEvent.setup()
    const admitInput = vi.fn((_text: string) => Promise.resolve())
    useAppStore.setState({
      admitInput,
      selection: { sessionId: "session_1" },
    })
    render(<Composer />)

    const textarea = screen.getByRole("textbox")
    await user.click(textarea)
    await user.keyboard("/com")

    const menu = screen.getByRole("listbox", { name: "Slash commands" })
    expect(menu.textContent).toContain("/compact")

    await user.keyboard("{Enter}")
    expect(admitInput).toHaveBeenCalledWith("/compact")
    expect(useAppStore.getState().promptDraft).toBe("")
    expect(screen.queryByRole("listbox")).toBeNull()
  })

  it("keeps the exact match selectable so Enter executes it", async () => {
    const user = userEvent.setup()
    const admitInput = vi.fn((_text: string) => Promise.resolve())
    useAppStore.setState({
      admitInput,
      selection: { sessionId: "session_1" },
    })
    render(<Composer />)

    await user.click(screen.getByRole("textbox"))
    await user.keyboard("/compact")
    expect(screen.getByRole("listbox")).toBeDefined()

    await user.keyboard("{Enter}")
    expect(admitInput).toHaveBeenCalledWith("/compact")
  })

  it("executes a clicked command", async () => {
    const user = userEvent.setup()
    const admitInput = vi.fn((_text: string) => Promise.resolve())
    useAppStore.setState({
      admitInput,
      selection: { sessionId: "session_1" },
    })
    render(<Composer />)

    await user.click(screen.getByRole("textbox"))
    await user.keyboard("/com")
    await user.click(screen.getByRole("option", { name: /\/compact/ }))

    expect(admitInput).toHaveBeenCalledWith("/compact")
    expect(useAppStore.getState().promptDraft).toBe("")
  })

  it("keeps the wrapped highlight selectable with arrow keys", async () => {
    const user = userEvent.setup()
    const admitInput = vi.fn((_text: string) => Promise.resolve())
    useAppStore.setState({
      admitInput,
      selection: { sessionId: "session_1" },
    })
    render(<Composer />)

    await user.click(screen.getByRole("textbox"))
    await user.keyboard("/")
    // One command: cycling wraps back onto it and Enter still executes.
    await user.keyboard("{ArrowDown}{ArrowUp}{Enter}")

    expect(admitInput).toHaveBeenCalledWith("/compact")
  })

  it("completes compact as text instead of executing while images are staged", async () => {
    const user = userEvent.setup()
    const admitInput = vi.fn((_text: string) => Promise.resolve())
    useAppStore.setState({
      admitInput,
      selection: { sessionId: "session_1" },
      promptAttachments: [draftImage("high")],
    })
    render(<Composer />)

    await user.click(screen.getByRole("textbox"))
    await user.keyboard("/com{Enter}")

    expect(admitInput).not.toHaveBeenCalled()
    expect(useAppStore.getState().promptDraft).toBe("/compact")
    // The exact match stays listed, but executing again is still blocked.
    expect(screen.getByRole("listbox")).toBeDefined()
    await user.keyboard("{Enter}")
    expect(admitInput).not.toHaveBeenCalled()
  })

  it("dismisses with Escape until the query changes", async () => {
    const user = userEvent.setup()
    useAppStore.setState({ selection: { sessionId: "session_1" } })
    render(<Composer />)

    const textarea = screen.getByRole("textbox")
    await user.click(textarea)
    await user.keyboard("/")
    expect(screen.getByRole("listbox")).toBeDefined()

    await user.keyboard("{Escape}")
    expect(screen.queryByRole("listbox")).toBeNull()

    await user.keyboard("c")
    expect(screen.getByRole("listbox")).toBeDefined()
  })

  it("stays closed once the draft takes arguments", async () => {
    const user = userEvent.setup()
    useAppStore.setState({ selection: { sessionId: "session_1" } })
    render(<Composer />)

    await user.click(screen.getByRole("textbox"))
    await user.keyboard("/compact now")

    expect(screen.queryByRole("listbox")).toBeNull()
  })
})

describe("skill mention popup", () => {
  const templateCreator = {
    name: "Template Creator",
    description: "Creates project templates",
    path: "/repo/.agents/skills/template-creator/SKILL.md",
    scope: "repo" as const,
  }
  const changelogWriter = {
    name: "Changelog Writer",
    description: "Writes changelogs",
    path: "/repo/.agents/skills/changelog-writer/SKILL.md",
    scope: "repo" as const,
  }

  function skillsState() {
    return {
      selection: { sessionId: "session_1" },
      sessionSkills: [templateCreator, changelogWriter],
    }
  }

  it("picks a skill with Enter, replacing the $token with a chip", async () => {
    const user = userEvent.setup()
    const admitInput = vi.fn((_text: string) => Promise.resolve())
    useAppStore.setState({ ...skillsState(), admitInput })
    render(<Composer />)

    const textarea = screen.getByRole("textbox")
    await user.click(textarea)
    await user.keyboard("use $tem")

    const menu = screen.getByRole("listbox", { name: "Skills" })
    expect(menu.textContent).toContain("Template Creator")
    expect(menu.textContent).not.toContain("Changelog Writer")

    await user.keyboard("{Enter}")
    expect(useAppStore.getState().promptDraft).toBe("use")
    expect(useAppStore.getState().promptSkills).toEqual([templateCreator])
    expect(admitInput).not.toHaveBeenCalled()
    expect(
      screen.getByRole("button", { name: "Remove Template Creator" }),
    ).toBeDefined()
  })

  it("sends a skill-only draft and clears the chips after admission", async () => {
    const user = userEvent.setup()
    const admitInput = vi.fn((_text: string) => Promise.resolve())
    useAppStore.setState({ ...skillsState(), admitInput })
    render(<Composer />)

    await user.click(screen.getByRole("textbox"))
    await user.keyboard("$tem{Enter}")
    await user.click(screen.getByRole("button", { name: "Send" }))

    // The store appends path-qualified mentions; the composer sends plain text.
    expect(admitInput).toHaveBeenCalledWith("")
  })

  it("cycles the highlight with arrow keys and picks with Tab", async () => {
    const user = userEvent.setup()
    useAppStore.setState(skillsState())
    render(<Composer />)

    await user.click(screen.getByRole("textbox"))
    await user.keyboard("$")
    await user.keyboard("{ArrowDown}{Tab}")

    expect(useAppStore.getState().promptSkills).toEqual([changelogWriter])
  })

  it("does not list an already picked skill again", async () => {
    const user = userEvent.setup()
    useAppStore.setState({
      ...skillsState(),
      promptSkills: [templateCreator],
    })
    render(<Composer />)

    await user.click(screen.getByRole("textbox"))
    await user.keyboard("$")

    const menu = screen.getByRole("listbox", { name: "Skills" })
    expect(menu.textContent).toContain("Changelog Writer")
    expect(menu.textContent).not.toContain("Template Creator")
  })

  it("dismisses with Escape until the query changes", async () => {
    const user = userEvent.setup()
    useAppStore.setState(skillsState())
    render(<Composer />)

    await user.click(screen.getByRole("textbox"))
    await user.keyboard("$")
    expect(screen.getByRole("listbox", { name: "Skills" })).toBeDefined()

    await user.keyboard("{Escape}")
    expect(screen.queryByRole("listbox", { name: "Skills" })).toBeNull()

    await user.keyboard("t")
    expect(screen.getByRole("listbox", { name: "Skills" })).toBeDefined()
  })

  it("removes a chip", async () => {
    const user = userEvent.setup()
    useAppStore.setState({
      ...skillsState(),
      promptSkills: [templateCreator],
    })
    render(<Composer />)

    await user.click(
      screen.getByRole("button", { name: "Remove Template Creator" }),
    )

    expect(useAppStore.getState().promptSkills).toEqual([])
  })

  it("blocks compact while skill chips are staged", async () => {
    const user = userEvent.setup()
    const admitInput = vi.fn((_text: string) => Promise.resolve())
    useAppStore.setState({
      ...skillsState(),
      admitInput,
      promptDraft: "/compact",
      promptSkills: [templateCreator],
    })
    render(<Composer />)

    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty(
      "disabled",
      true,
    )
    await user.click(screen.getByRole("textbox"))
    await user.keyboard("{Enter}")
    expect(admitInput).not.toHaveBeenCalled()
    expect(useAppStore.getState().promptDraft).toBe("/compact")
  })
})

describe("model selector", () => {
  function selectModelState() {
    return {
      selection: { sessionId: "session_1" },
      providers: [
        {
          name: "openai",
          defaultModel: "gpt-5.1-codex",
          models: [
            {
              id: "gpt-5.1-codex",
              displayName: "GPT 5.1 Codex",
              instructionProfileId: "codex",
              efforts: ["low", "medium", "high"],
              speeds: ["standard", "fast"],
            },
            {
              id: "gpt-5",
              displayName: "GPT-5",
              instructionProfileId: "codex",
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
              instructionProfileId: "codex",
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
              instructionProfileId: "kimi",
            },
            {
              id: "k3",
              displayName: "K3",
              instructionProfileId: "kimi",
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
              instructionProfileId: "anthropic",
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
              instructionProfileId: "default",
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
        },
      },
    })
    useAppStore.setState({
      ...selectModelState(),
      execution: reduceExecutionView(createExecutionViewState(), {
        type: "durable",
        event: started,
      }),
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

  it("does not offer providers that require login", async () => {
    const user = userEvent.setup()
    window.localStorage.clear()
    const state = selectModelState()
    useAppStore.setState({
      ...state,
      providers: state.providers.map((provider) =>
        provider.name === "codex"
          ? { ...provider, availability: "requires_login" as const }
          : provider,
      ),
      modelSelections: {},
    })
    render(<Composer />)

    await user.click(screen.getByRole("button", { name: "Select model" }))

    expect(screen.queryByText("codex")).toBeNull()
    expect(screen.queryByRole("button", { name: "GPT-5.6 Sol" })).toBeNull()
    expect(screen.getByText("openai")).toBeDefined()
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
      expect(fakeRef.current.requestsFor("userPreference/write")).toEqual([
        {
          method: "userPreference/write",
          params: {
            provider: "openai",
            model: "gpt-5.1-codex",
            effort: "low",
          },
        },
      ])
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
