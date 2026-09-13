// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ConversationScrollContext } from "../../src/gui/hooks/conversation-scroll-context.ts"
import { skillMentionText } from "../../src/gui/components/prompt-document.ts"
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
import {
  createEventEnvelope,
  EventType,
  InputRole,
} from "../../src/kernel/events.ts"
import { pastePrompt, selectPrompt } from "./prompt-editor-helpers.ts"
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

  it("resumes latest-output following when the reader sends from history", async () => {
    const user = userEvent.setup()
    const jumpToBottom = vi.fn()
    const admitInput = vi.fn(async () => {})
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      promptDraft: "Continue",
      admitInput,
    })
    render(
      <ConversationScrollContext.Provider value={{ jumpToBottom }}>
        <Composer />
      </ConversationScrollContext.Provider>,
    )
    await user.click(screen.getByRole("button", { name: "Send" }))
    expect(admitInput).toHaveBeenCalledWith("Continue")
    expect(jumpToBottom).toHaveBeenCalledOnce()
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

  it("previews an attached image with zoom controls", async () => {
    const user = userEvent.setup()
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      promptAttachments: [draftImage("high")],
    })
    render(<Composer />)

    await user.click(
      screen.getByRole("button", { name: "Preview screenshot.png" }),
    )
    const dialog = screen.getByRole("dialog", {
      name: "Preview screenshot.png",
    })
    expect(dialog.textContent).toContain("100%")

    await user.click(screen.getByRole("button", { name: "Zoom in" }))
    expect(dialog.textContent).toContain("125%")
    await user.click(screen.getByRole("button", { name: "Reset zoom" }))
    expect(dialog.textContent).toContain("100%")

    await user.click(screen.getByRole("button", { name: "Close preview" }))
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("closes the image preview with Escape", async () => {
    const user = userEvent.setup()
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      promptAttachments: [draftImage("high")],
    })
    render(<Composer />)

    await user.click(
      screen.getByRole("button", { name: "Preview screenshot.png" }),
    )
    expect(screen.getByRole("dialog")).toBeDefined()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).toBeNull()
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
    await selectPrompt(textarea, 0)
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
    await selectPrompt(textarea, 2)
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
    await selectPrompt(textarea, 0)
    await user.keyboard("{ArrowUp}")
    expect(useAppStore.getState().promptDraft).toBe("first question")

    await pastePrompt(textarea, "edited", true)
    await selectPrompt(textarea, 0)
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
    await pastePrompt(screen.getByRole("textbox"), "/com")

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
    await pastePrompt(screen.getByRole("textbox"), "/compact")
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
    await pastePrompt(screen.getByRole("textbox"), "/com")
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
    await pastePrompt(screen.getByRole("textbox"), "/")
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
    await pastePrompt(screen.getByRole("textbox"), "/com")
    await user.keyboard("{Enter}")

    expect(admitInput).not.toHaveBeenCalled()
    expect(useAppStore.getState().promptDraft).toBe("/compact")
    // The exact match stays listed, but executing again is still blocked.
    expect(screen.getByRole("listbox")).toBeDefined()
    await user.keyboard("{Enter}")
    expect(admitInput).not.toHaveBeenCalled()
  })

  it("completes the command as text while the session model is restoring", async () => {
    const user = userEvent.setup()
    const admitInput = vi.fn((_text: string) => Promise.resolve())
    useAppStore.setState({
      admitInput,
      selection: { sessionId: "session_1" },
      restoringModelSelectionFor: "session_1",
    })
    render(<Composer />)

    await user.click(screen.getByRole("textbox"))
    await pastePrompt(screen.getByRole("textbox"), "/com")
    await user.keyboard("{Enter}")

    expect(admitInput).not.toHaveBeenCalled()
    expect(useAppStore.getState().promptDraft).toBe("/compact")
  })

  it("dismisses with Escape until the query changes", async () => {
    const user = userEvent.setup()
    useAppStore.setState({ selection: { sessionId: "session_1" } })
    render(<Composer />)

    const textarea = screen.getByRole("textbox")
    await user.click(textarea)
    await pastePrompt(screen.getByRole("textbox"), "/")
    expect(screen.getByRole("listbox")).toBeDefined()

    await user.keyboard("{Escape}")
    expect(screen.queryByRole("listbox")).toBeNull()

    await pastePrompt(screen.getByRole("textbox"), "c")
    expect(screen.getByRole("listbox")).toBeDefined()
  })

  it("stays closed once the draft takes arguments", async () => {
    const user = userEvent.setup()
    useAppStore.setState({ selection: { sessionId: "session_1" } })
    render(<Composer />)

    await user.click(screen.getByRole("textbox"))
    await pastePrompt(screen.getByRole("textbox"), "/compact now")

    expect(screen.queryByRole("listbox")).toBeNull()
  })

  it("lets Shift+Enter insert a newline while the menu is open", async () => {
    const user = userEvent.setup()
    const admitInput = vi.fn((_text: string) => Promise.resolve())
    useAppStore.setState({
      admitInput,
      selection: { sessionId: "session_1" },
    })
    render(<Composer />)

    await user.click(screen.getByRole("textbox"))
    await pastePrompt(screen.getByRole("textbox"), "/com")
    await user.keyboard("{Shift>}{Enter}{/Shift}")

    expect(admitInput).not.toHaveBeenCalled()
    expect(useAppStore.getState().promptDraft).toBe("/com\n")
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
    await pastePrompt(screen.getByRole("textbox"), "use $tem")

    const menu = screen.getByRole("listbox", { name: "Skills" })
    expect(menu.textContent).toContain("Template Creator")
    expect(menu.textContent).not.toContain("Changelog Writer")

    await user.keyboard("{Enter}")
    expect(useAppStore.getState().promptDraft).toBe(
      `use ${skillMentionText(templateCreator)} `,
    )
    expect(admitInput).not.toHaveBeenCalled()
    expect(
      screen.getByRole("textbox").querySelector("[data-skill-path]"),
    ).toBeDefined()
  })

  it("sends a skill-only draft and clears the chips after admission", async () => {
    const user = userEvent.setup()
    const admitInput = vi.fn((_text: string) => Promise.resolve())
    useAppStore.setState({ ...skillsState(), admitInput })
    render(<Composer />)

    await user.click(screen.getByRole("textbox"))
    await pastePrompt(screen.getByRole("textbox"), "$tem")
    await user.keyboard("{Enter}")
    await user.click(screen.getByRole("button", { name: "Send" }))

    expect(admitInput).toHaveBeenCalledWith(skillMentionText(templateCreator))
  })

  it("cycles the sorted skill list and inserts the selected skill with Tab", async () => {
    const user = userEvent.setup()
    useAppStore.setState(skillsState())
    render(<Composer />)

    await user.click(screen.getByRole("textbox"))
    await pastePrompt(screen.getByRole("textbox"), "$")
    await user.keyboard("{ArrowDown}{Tab}")

    expect(useAppStore.getState().promptDraft).toBe(
      `${skillMentionText(templateCreator)} `,
    )
  })

  it("does not list an already picked skill again", async () => {
    const user = userEvent.setup()
    useAppStore.setState({
      ...skillsState(),
      promptDraft: `${skillMentionText(templateCreator)} `,
    })
    render(<Composer />)

    await user.click(screen.getByRole("textbox"))
    await pastePrompt(screen.getByRole("textbox"), "$")

    const menu = screen.getByRole("listbox", { name: "Skills" })
    expect(menu.textContent).toContain("Changelog Writer")
    expect(menu.textContent).not.toContain("Template Creator")
  })

  it("dismisses with Escape until the query changes", async () => {
    const user = userEvent.setup()
    useAppStore.setState(skillsState())
    render(<Composer />)

    await user.click(screen.getByRole("textbox"))
    await pastePrompt(screen.getByRole("textbox"), "$")
    expect(screen.getByRole("listbox", { name: "Skills" })).toBeDefined()

    await user.keyboard("{Escape}")
    expect(screen.queryByRole("listbox", { name: "Skills" })).toBeNull()

    await pastePrompt(screen.getByRole("textbox"), "t")
    expect(screen.getByRole("listbox", { name: "Skills" })).toBeDefined()
  })

  it("closes the mention popup when the cursor leaves the trailing token", async () => {
    const user = userEvent.setup()
    const admitInput = vi.fn((_text: string) => Promise.resolve())
    useAppStore.setState({ ...skillsState(), admitInput })
    render(<Composer />)

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    await user.click(textarea)
    await pastePrompt(screen.getByRole("textbox"), "use $tem")
    expect(screen.getByRole("listbox", { name: "Skills" })).toBeDefined()

    await selectPrompt(textarea, 2)
    expect(screen.queryByRole("listbox", { name: "Skills" })).toBeNull()

    await user.keyboard("{Enter}")
    expect(admitInput).toHaveBeenCalledWith("use $tem")
  })

  it("treats a command with inline skills as ordinary message text", async () => {
    const user = userEvent.setup()
    const admitInput = vi.fn(async () => {})
    const draft = `/compact ${skillMentionText(templateCreator)}`
    useAppStore.setState({ ...skillsState(), admitInput, promptDraft: draft })
    render(<Composer />)
    await user.click(screen.getByRole("button", { name: "Send" }))
    expect(admitInput).toHaveBeenCalledWith(draft)
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
    ).toBe("Claude Sonnet 4.6")
    expect(
      screen.getByRole("button", { name: "Select effort" }).textContent,
    ).toBe("low")
  })

  it("groups model rows by provider under a Select model header", async () => {
    const user = userEvent.setup()
    window.localStorage.clear()
    useAppStore.setState({ ...selectModelState(), modelSelections: {} })
    render(<Composer />)

    await user.click(screen.getByRole("button", { name: "Select model" }))

    expect(screen.getByText("Select model")).toBeDefined()
    expect(screen.getByText("Recommended set of models")).toBeDefined()
    expect(screen.getByText("openai")).toBeDefined()
    expect(screen.getByText("anthropic")).toBeDefined()
    expect(screen.getByRole("button", { name: "GPT 5.1 Codex" })).toBeDefined()
    expect(
      screen.getByRole("button", { name: "Claude Sonnet 4.6" }),
    ).toBeDefined()
    expect(
      screen.getByRole("button", { name: "Grok 4.20 Non-Reasoning" }),
    ).toBeDefined()
  })

  it("offers effort stops and a speed toggle for reasoning models", async () => {
    const user = userEvent.setup()
    window.localStorage.clear()
    useAppStore.setState({ ...selectModelState(), modelSelections: {} })
    render(<Composer />)

    await user.click(screen.getByRole("button", { name: "Select effort" }))

    // The effective default model is a reasoning model: effort stops show.
    expect(screen.getByRole("slider", { name: "Reasoning effort" }))
    expect(screen.getByRole("button", { name: "low" })).toBeDefined()
    expect(screen.getByRole("button", { name: "medium" })).toBeDefined()
    expect(screen.getByRole("button", { name: "high" })).toBeDefined()

    // And it has a speed tier toggle.
    expect(screen.getByRole("button", { name: "Use fast speed" })).toBeDefined()
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

  it("pins an effort for the effective model and resets it to default", async () => {
    const user = userEvent.setup()
    window.localStorage.clear()
    useAppStore.setState({ ...selectModelState(), modelSelections: {} })
    render(<Composer />)

    await user.click(screen.getByRole("button", { name: "Select effort" }))
    await user.click(screen.getByRole("button", { name: "high" }))

    expect(useAppStore.getState().modelSelections).toEqual({
      session_1: { provider: "openai", model: "gpt-5.1-codex", effort: "high" },
    })
    expect(
      screen.getByRole("button", { name: "Select effort" }).textContent,
    ).toBe("high")

    // The reset control clears only the effort, keeping the model.
    await user.click(
      screen.getByRole("button", { name: "Reset effort to default" }),
    )

    expect(useAppStore.getState().modelSelections).toEqual({
      session_1: { provider: "openai", model: "gpt-5.1-codex" },
    })
  })

  it("hides the effort pill when the effective model offers none", async () => {
    const user = userEvent.setup()
    window.localStorage.clear()
    useAppStore.setState({
      ...selectModelState(),
      modelSelections: {
        session_1: { provider: "grok", model: "grok-4.20-non-reasoning" },
      },
    })
    render(<Composer />)

    expect(screen.queryByRole("button", { name: "Select effort" })).toBeNull()

    await user.click(screen.getByRole("button", { name: "Select model" }))
    const selectedRow = screen.getByRole("button", {
      name: "Grok 4.20 Non-Reasoning",
    })
    expect(selectedRow.querySelector("svg")).not.toBeNull()
  })

  it("keeps K2.7 thinking on without exposing K3 effort levels", () => {
    window.localStorage.clear()
    useAppStore.setState({
      ...selectModelState(),
      modelSelections: {
        session_1: { provider: "kimi", model: "kimi-for-coding" },
      },
    })
    render(<Composer />)

    expect(screen.queryByRole("button", { name: "Select effort" })).toBeNull()
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

    await user.click(screen.getByRole("button", { name: "Select effort" }))
    await user.click(screen.getByRole("button", { name: "Use fast speed" }))

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

    await user.click(screen.getByRole("button", { name: "Use standard speed" }))

    expect(useAppStore.getState().modelSelections).toEqual({
      session_1: { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
    })
  })

  it("shows the standard speed state for an explicit standard speed", async () => {
    const user = userEvent.setup()
    window.localStorage.clear()
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

    await user.click(screen.getByRole("button", { name: "Select effort" }))

    expect(screen.getByRole("button", { name: "Use fast speed" })).toBeDefined()
    expect(
      screen.queryByRole("button", { name: "Use standard speed" }),
    ).toBeNull()
  })

  it("hides the speed toggle for providers without tiers", async () => {
    const user = userEvent.setup()
    window.localStorage.clear()
    useAppStore.setState({
      ...selectModelState(),
      modelSelections: {
        session_1: { provider: "anthropic", model: "claude-sonnet-4-6" },
      },
    })
    render(<Composer />)

    await user.click(screen.getByRole("button", { name: "Select effort" }))

    expect(
      screen.getByRole("slider", { name: "Reasoning effort" }),
    ).toBeDefined()
    expect(screen.queryByRole("button", { name: /speed/ })).toBeNull()
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

describe("unified composer suggestions", () => {
  const skill = {
    name: "review",
    description: "Review changes",
    path: "/skills/review/SKILL.md",
    scope: "user" as const,
  }

  it("selects a skill through slash without submitting a message", async () => {
    const user = userEvent.setup()
    const admitInput = vi.fn(async () => {})
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      sessionSkills: [skill],
      admitInput,
    })
    render(<Composer />)
    await pastePrompt(screen.getByRole("textbox"), "/rev")
    await user.keyboard("{Enter}")
    expect(useAppStore.getState().promptDraft).toBe(
      `${skillMentionText(skill)} `,
    )
    expect(admitInput).not.toHaveBeenCalled()
  })

  it("reopens a dismissed query after the user clears and types it again", async () => {
    const user = userEvent.setup()
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      sessionSkills: [skill],
    })
    render(<Composer />)
    await pastePrompt(screen.getByRole("textbox"), "/rev")
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("listbox")).toBeNull()
    await pastePrompt(screen.getByRole("textbox"), "", true)
    await pastePrompt(screen.getByRole("textbox"), "/rev")
    expect(
      screen.getByRole("option", { name: /review Review changes/ }),
    ).toBeDefined()
  })

  it("selects commands with Tab like the inline Codex command menu", async () => {
    const user = userEvent.setup()
    const admitInput = vi.fn(async () => {})
    useAppStore.setState({ selection: { sessionId: "session_1" }, admitInput })
    render(<Composer />)
    await pastePrompt(screen.getByRole("textbox"), "/com")
    await user.keyboard("{Tab}")
    expect(useAppStore.getState().promptDraft).toBe("")
    expect(admitInput).toHaveBeenCalledWith("/compact")
  })

  it("replaces a skill token at the caret without deleting surrounding text", async () => {
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      sessionSkills: [skill],
      promptDraft: "Please $rev then test",
    })
    render(<Composer />)
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    textarea.focus()
    await selectPrompt(textarea, 11)
    fireEvent.keyDown(textarea, { key: "Enter" })
    expect(useAppStore.getState().promptDraft).toBe(
      `Please ${skillMentionText(skill)}  then test`,
    )
  })

  it("dismisses suggestions and removes the last skill chip with Backspace on empty input", async () => {
    const user = userEvent.setup()
    useAppStore.setState({
      selection: { sessionId: "session_1" },
      sessionSkills: [skill],
    })
    render(<Composer />)
    await pastePrompt(screen.getByRole("textbox"), "/")
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("listbox")).toBeNull()
    await pastePrompt(screen.getByRole("textbox"), "", true)
    await pastePrompt(screen.getByRole("textbox"), "$rev")
    await user.keyboard("{Enter}")
    expect(
      screen.getByRole("textbox").querySelector("[data-skill-path]"),
    ).not.toBeNull()
    await pastePrompt(
      screen.getByRole("textbox"),
      skillMentionText(skill),
      true,
    )
    await user.keyboard("{Backspace}")
    expect(
      screen.getByRole("textbox").querySelector("[data-skill-path]"),
    ).toBeNull()
  })
})
