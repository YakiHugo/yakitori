// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { StrictMode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Composer } from "../../src/gui/components/composer.tsx"
import { SideChatPanel } from "../../src/gui/components/side-chat-panel.tsx"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import { useWorkspaceStore } from "../../src/gui/store/workspace-store.ts"
import type {
  SideChatSend,
  SideChatSnapshot,
} from "../../src/server/side-chat.ts"
import { inputFixture } from "../fixtures/user-input.ts"
import { inputParts } from "./input-fixtures.ts"
import { pastePrompt, selectPrompt } from "./prompt-editor-helpers.ts"

const client = vi.hoisted(() => ({
  request:
    vi.fn<
      (method: string, params: Record<string, unknown>) => Promise<unknown>
    >(),
  subscribeToSideChatChanges:
    vi.fn<
      (listener: (snapshot: SideChatSnapshot | undefined) => void) => () => void
    >(),
}))
vi.mock("../../src/gui/lib/rpc-client.ts", () => ({
  getAppRpcClient: () => client,
}))

const listeners = new Set<(snapshot: SideChatSnapshot | undefined) => void>()
const modelA = { provider: "test", model: "a" }
const modelB = { provider: "test", model: "b" }
function snapshot(
  revision = 0,
  extra: Partial<SideChatSnapshot> = {},
): SideChatSnapshot {
  return {
    id: "side-chat",
    revision,
    cwd: "/repo",
    modelSelection: modelA,
    expiresAt: "2099-01-01T00:00:00.000Z",
    messages: [],
    ...extra,
  }
}

function acceptedSnapshot(
  revision = 1,
  extra: Partial<SideChatSnapshot> = {},
): SideChatSnapshot {
  const request = requests("sideChat/send").at(-1) as SideChatSend | undefined
  if (!request) throw new Error("Missing test side-chat send request")
  return snapshot(revision, {
    ...extra,
    messages: [
      {
        id: request.requestId,
        turnId: extra.activeTurnId ?? "turn",
        role: "user",
        content: structuredClone(request.content),
        streaming: false,
      },
      ...(extra.messages ?? []),
    ],
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function Panel() {
  const tab = useWorkspaceStore((state) =>
    state.tabs.find((entry) => entry.id === "chat-tab"),
  )
  if (tab?.kind !== "chat") throw new Error("Missing chat tab")
  return (
    <SideChatPanel tab={tab} cwd="/repo" apiBase="http://api.test" active />
  )
}

function requests(method: string) {
  return client.request.mock.calls
    .filter(([name]) => name === method)
    .map(([, params]) => params)
}

beforeEach(() => {
  listeners.clear()
  client.request.mockReset()
  client.subscribeToSideChatChanges.mockReset()
  client.subscribeToSideChatChanges.mockImplementation((listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  })
  useAppStore.setState({
    ...createInitialAppState(),
    selection: { sessionId: "main-session" },
    modelSelections: { "main-session": modelA },
    userPreference: modelA,
    defaultProvider: "test",
    defaultModel: "a",
    promptDraft: inputParts("Main conversation draft"),
    providers: [
      {
        name: "test",
        models: ["a", "b", "c"].map((id) => ({
          id,
          displayName: `Model ${id.toUpperCase()}`,
          instructionProfileId: "codex",
          effortStyle: "none",
        })),
      },
    ],
  })
  useWorkspaceStore.setState({
    tabs: [
      {
        id: "chat-tab",
        kind: "chat",
        draft: inputParts("Explain"),
        excerpts: [],
        sourceSessionId: "main-session",
      },
    ],
    activeId: "chat-tab",
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useWorkspaceStore.setState({ tabs: [], activeId: undefined })
  useAppStore.setState(createInitialAppState())
})

describe("side chat panel", () => {
  it("keeps expired history readable and opens a new chat in the original parent session", async () => {
    const history = snapshot(1, {
      expiresAt: "2020-01-01T00:00:00.000Z",
      messages: [
        {
          id: "answer",
          turnId: "turn",
          role: "assistant",
          text: "An earlier answer",
          streaming: false,
        },
      ],
    })
    client.request.mockImplementation(async (method) =>
      method === "sideChat/create" ? history : {},
    )
    render(<Panel />)
    expect(await screen.findByText("An earlier answer")).toBeDefined()
    expect(
      screen.getByText("Side chat expired. Start a new side chat to continue."),
    ).toBeDefined()
    expect(
      screen.queryByRole("textbox", { name: "Message side chat" }),
    ).toBeNull()
    expect(
      (
        screen.getByRole("textbox", {
          name: "Unsent side chat draft",
        }) as HTMLElement
      ).textContent,
    ).toBe("Explain")
    expect(
      screen
        .getByRole("textbox", { name: "Unsent side chat draft" })
        .getAttribute("contenteditable"),
    ).toBe("false")
    expect(requests("sideChat/send")).toEqual([])
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Start new side chat" }))
    const tabs = useWorkspaceStore.getState().tabs
    expect(tabs).toHaveLength(2)
    expect(tabs[1]).toMatchObject({
      kind: "chat",
      sourceSessionId: "main-session",
      draft: inputParts(""),
    })
    expect(useWorkspaceStore.getState().activeId).toBe(tabs[1]?.id)
    expect(screen.getByText("An earlier answer")).toBeDefined()
  })

  it("expires on its timer while a response is active without canceling it", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
    client.request.mockImplementation(async (method) =>
      method === "sideChat/create"
        ? snapshot(1, {
            expiresAt: "2026-01-01T00:00:01.000Z",
            activeTurnId: "turn",
            messages: [
              {
                id: "partial",
                turnId: "turn",
                role: "assistant",
                text: "Partial answer",
                streaming: true,
              },
            ],
          })
        : {},
    )
    await act(async () => {
      render(<Panel />)
    })
    expect(
      screen.getByRole("textbox", { name: "Message side chat" }),
    ).toBeDefined()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_001)
    })
    expect(
      screen.queryByRole("textbox", { name: "Message side chat" }),
    ).toBeNull()
    expect(screen.getByText("Partial answer")).toBeDefined()
    expect(screen.getByText("Responding…")).toBeDefined()
    expect(requests("sideChat/cancel")).toEqual([])
    expect(screen.getByRole("button", { name: "Stop response" })).toBeDefined()
    await act(async () => {
      for (const listener of listeners)
        listener(
          snapshot(2, {
            expiresAt: "2026-01-01T00:00:01.000Z",
            messages: [
              {
                id: "partial",
                turnId: "turn",
                role: "assistant",
                text: "Completed answer",
                streaming: false,
              },
            ],
          }),
        )
    })
    expect(screen.getByText("Completed answer")).toBeDefined()
    expect(requests("sideChat/cancel")).toEqual([])
  })

  it("still permits an explicit stop after expiry", async () => {
    client.request.mockImplementation(async (method) => {
      if (method === "sideChat/create")
        return snapshot(1, {
          expiresAt: "2020-01-01T00:00:00.000Z",
          activeTurnId: "turn",
        })
      if (method === "sideChat/cancel")
        return snapshot(2, { expiresAt: "2020-01-01T00:00:00.000Z" })
      return {}
    })
    render(<Panel />)
    fireEvent.click(
      await screen.findByRole("button", { name: "Stop response" }),
    )
    expect(requests("sideChat/cancel")).toEqual([
      { sideChatId: "side-chat", turnId: "turn" },
    ])
    expect(requests("sideChat/send")).toEqual([])
  })

  it("guards a send when creation returns an already expired snapshot", async () => {
    const creating = deferred<SideChatSnapshot>()
    client.request.mockImplementation(async (method) =>
      method === "sideChat/create" ? creating.promise : {},
    )
    render(<Panel />)
    fireEvent.click(
      screen.getByRole("button", { name: "Send side chat message" }),
    )
    await act(async () =>
      creating.resolve(snapshot(1, { expiresAt: "2020-01-01T00:00:00.000Z" })),
    )
    expect(requests("sideChat/send")).toEqual([])
    expect(
      screen.getByText("Side chat expired. Start a new side chat to continue."),
    ).toBeDefined()
  })

  it("keeps a server expiry rejection authoritative when the client clock lags", async () => {
    client.request.mockImplementation(async (method) => {
      if (method === "sideChat/create") return snapshot()
      if (method === "sideChat/send")
        throw new Error(
          "This side conversation is read-only after 24 hours of inactivity.",
        )
      if (method === "sideChat/read")
        return snapshot(2, {
          messages: [
            {
              id: "previous",
              turnId: "earlier",
              role: "assistant",
              text: "Previous answer",
              streaming: false,
            },
          ],
        })
      return {}
    })
    render(<Panel />)
    fireEvent.click(
      screen.getByRole("button", { name: "Send side chat message" }),
    )
    expect(
      await screen.findByText(
        "This side conversation is read-only after 24 hours of inactivity.",
      ),
    ).toBeDefined()
    expect(await screen.findByText("Previous answer")).toBeDefined()
    expect(requests("sideChat/read")).toEqual([{ sideChatId: "side-chat" }])
    expect(
      screen.queryByRole("textbox", { name: "Message side chat" }),
    ).toBeNull()
    expect(useWorkspaceStore.getState().tabs[0]).toMatchObject({
      draft: inputParts("Explain"),
    })
  })

  it("resumes the composer when a newer snapshot extends the expiry", async () => {
    client.request.mockImplementation(async (method) => {
      if (method === "sideChat/create") return snapshot()
      if (method === "sideChat/send")
        throw new Error(
          "This side conversation is read-only after 24 hours of inactivity.",
        )
      if (method === "sideChat/read")
        return snapshot(2, {
          expiresAt: "2099-02-01T00:00:00.000Z",
        })
      return {}
    })
    render(<Panel />)
    fireEvent.click(
      screen.getByRole("button", { name: "Send side chat message" }),
    )
    await waitFor(() => expect(requests("sideChat/read")).toHaveLength(1))
    expect(
      screen.getByRole("textbox", { name: "Message side chat" }),
    ).toBeDefined()
    expect(
      screen.queryByRole("button", { name: "Start new side chat" }),
    ).toBeNull()
  })

  it("renders consecutive turns with markdown spacing and bounded user bubbles", async () => {
    client.request.mockImplementation(async (method) =>
      method === "sideChat/create"
        ? snapshot(1, {
            messages: [
              {
                id: "input",
                turnId: "turn",
                role: "user",
                content: inputFixture(inputParts("First question")),
                streaming: false,
              },
              {
                id: "answer",
                turnId: "turn",
                role: "assistant",
                text: "First paragraph\n\nSecond paragraph",
                streaming: false,
              },
              {
                id: "followup",
                turnId: "next-turn",
                role: "user",
                content: inputFixture(inputParts("Follow up")),
                streaming: false,
              },
            ],
          })
        : {},
    )
    render(<Panel />)
    const log = await screen.findByRole("log", { name: "Side chat messages" })
    await waitFor(() =>
      expect(log.querySelectorAll(".side-chat-message")).toHaveLength(3),
    )
    const messages = [...log.querySelectorAll(".side-chat-message")]
    expect(messages[0]?.textContent).toBe("First question")
    expect(messages[2]?.textContent).toBe("Follow up")
    expect(
      messages[0]?.querySelector(".markdown.side-chat-user-bubble"),
    ).not.toBeNull()
    expect(
      [...(messages[1]?.querySelectorAll(".markdown p") ?? [])].map(
        (paragraph) => paragraph.textContent?.trim(),
      ),
    ).toEqual(["First paragraph", "Second paragraph"])
    expect(
      messages[2]?.querySelector(".markdown.side-chat-user-bubble"),
    ).not.toBeNull()
  })

  it("creates its fork on mount without sending and reuses pending creation for the first send", async () => {
    const creating = deferred<SideChatSnapshot>()
    client.request.mockImplementation(async (method) => {
      if (method === "sideChat/create") return creating.promise
      if (method === "sideChat/send") return acceptedSnapshot(1)
      return {}
    })
    const user = userEvent.setup()
    render(
      <StrictMode>
        <Panel />
      </StrictMode>,
    )
    expect(requests("sideChat/create")).toEqual([
      { cwd: "/repo", sourceSessionId: "main-session", modelSelection: modelA },
    ])
    expect(requests("sideChat/send")).toEqual([])
    expect(useWorkspaceStore.getState().tabs[0]).toMatchObject({
      draft: inputParts("Explain"),
    })
    await user.click(
      screen.getByRole("button", { name: "Send side chat message" }),
    )
    expect(requests("sideChat/create")).toHaveLength(1)
    expect(requests("sideChat/send")).toEqual([])
    await act(async () => creating.resolve(snapshot()))
    expect(requests("sideChat/send")).toHaveLength(1)
    expect(requests("sideChat/send")[0]).toMatchObject({
      sideChatId: "side-chat",
      content: inputFixture(inputParts("Explain")),
    })
  })

  it("closes an untouched fork that finishes creation after its tab closes", async () => {
    const creating = deferred<SideChatSnapshot>()
    client.request.mockImplementation(async (method) =>
      method === "sideChat/create" ? creating.promise : {},
    )
    const view = render(<Panel />)
    expect(requests("sideChat/create")).toHaveLength(1)
    view.unmount()
    await act(async () => creating.resolve(snapshot()))
    expect(requests("sideChat/close")).toEqual([{ sideChatId: "side-chat" }])
    expect(requests("sideChat/send")).toEqual([])
    expect(listeners.size).toBe(0)
  })

  it("keeps newer streamed snapshots over send and reconnect responses, stops, and closes its chat", async () => {
    const sending = deferred<SideChatSnapshot>()
    client.request.mockImplementation(async (method) => {
      if (method === "sideChat/create") return snapshot()
      if (method === "sideChat/send") return sending.promise
      if (method === "sideChat/read") return snapshot(2)
      if (method === "sideChat/cancel")
        return snapshot(5, {
          messages: [
            {
              id: "assistant",
              turnId: "turn",
              role: "assistant",
              text: "Streamed prefix",
              streaming: false,
            },
          ],
        })
      return {}
    })
    const user = userEvent.setup()
    const view = render(<Panel />)
    await user.click(
      screen.getByRole("button", { name: "Send side chat message" }),
    )
    expect(requests("sideChat/create")).toEqual([
      { cwd: "/repo", modelSelection: modelA, sourceSessionId: "main-session" },
    ])
    await act(async () => {
      for (const listener of listeners)
        listener(
          snapshot(4, {
            activeTurnId: "turn",
            messages: [
              {
                id: "assistant",
                turnId: "turn",
                role: "assistant",
                text: "Streamed prefix",
                streaming: true,
              },
            ],
          }),
        )
    })
    expect(screen.getByText("Streamed prefix")).toBeDefined()
    expect(
      useWorkspaceStore.getState().tabs.find((tab) => tab.id === "chat-tab"),
    ).toMatchObject({ hasMessages: true, activeTurnId: "turn" })
    await act(async () => sending.resolve(acceptedSnapshot(1)))
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.getByText("Streamed prefix")).toBeDefined()
    expect(
      (
        screen.getByRole("textbox", {
          name: "Message side chat",
        }) as HTMLElement
      ).textContent,
    ).toBe("")
    await act(async () => {
      for (const listener of listeners) listener(undefined)
    })
    expect(requests("sideChat/read")).toEqual([{ sideChatId: "side-chat" }])
    expect(screen.getByText("Streamed prefix")).toBeDefined()
    await user.click(screen.getByRole("button", { name: "Stop side chat" }))
    expect(requests("sideChat/cancel")).toEqual([
      { sideChatId: "side-chat", turnId: "turn" },
    ])
    expect(screen.queryByText("Responding…")).toBeNull()
    expect(screen.getByText("Streamed prefix")).toBeDefined()
    view.unmount()
    expect(requests("sideChat/close")).toEqual([{ sideChatId: "side-chat" }])
    expect(listeners.size).toBe(0)
  })

  it("retries the same model identity but creates a new request after a local model change", async () => {
    client.request.mockImplementation(async (method) => {
      if (method === "sideChat/create") return snapshot()
      if (method === "sideChat/send") throw new Error("Connection lost")
      return {}
    })
    const user = userEvent.setup()
    render(<Panel />)
    await user.click(
      screen.getByRole("button", { name: "Send side chat message" }),
    )
    await screen.findByRole("alert")
    await user.click(
      screen.getByRole("button", { name: "Send side chat message" }),
    )
    const [first, retry] = requests("sideChat/send")
    expect(retry).toEqual(first)
    await user.click(
      screen.getByRole("button", { name: "Select model and effort" }),
    )
    await user.click(screen.getByRole("button", { name: "Model B" }))
    expect(useAppStore.getState().modelSelections["main-session"]).toEqual(
      modelA,
    )
    expect(useAppStore.getState().userPreference).toEqual(modelA)
    await user.click(
      screen.getByRole("button", { name: "Send side chat message" }),
    )
    const changed = requests("sideChat/send")[2]
    expect(changed?.requestId).not.toBe(first?.requestId)
    expect(changed).toMatchObject({
      content: inputFixture(inputParts("Explain")),
      modelSelection: modelB,
    })
    await act(async () =>
      useAppStore.setState({
        modelSelections: { "main-session": { provider: "test", model: "c" } },
      }),
    )
    expect(
      screen.getByRole("button", { name: "Select model and effort" })
        .textContent,
    ).toContain("Model B")
    await user.click(
      screen.getByRole("button", { name: "Select model and effort" }),
    )
    await user.click(
      screen.getByRole("button", {
        name: /Default.*Recommended set of models/,
      }),
    )
    await user.click(
      screen.getByRole("button", { name: "Send side chat message" }),
    )
    const defaultAttempt = requests("sideChat/send")[3]
    expect(defaultAttempt?.requestId).not.toBe(changed?.requestId)
    expect(defaultAttempt?.modelSelection).toEqual(modelA)
    expect(useAppStore.getState().promptDraft).toEqual(
      inputParts("Main conversation draft"),
    )
  })

  it("closes a chat created after its tab unmounts without sending the pending message", async () => {
    const creating = deferred<SideChatSnapshot>()
    client.request.mockImplementation(async (method) =>
      method === "sideChat/create" ? creating.promise : {},
    )
    const user = userEvent.setup()
    const view = render(<Panel />)
    await user.click(
      screen.getByRole("button", { name: "Send side chat message" }),
    )
    view.unmount()
    await act(async () => creating.resolve(snapshot()))
    await waitFor(() =>
      expect(requests("sideChat/close")).toEqual([{ sideChatId: "side-chat" }]),
    )
    expect(requests("sideChat/send")).toEqual([])
    expect(listeners.size).toBe(0)
  })

  it("sends the captured excerpts without clearing newer context or changing the main draft", async () => {
    const sending = deferred<SideChatSnapshot>()
    client.request.mockImplementation(async (method) => {
      if (method === "sideChat/create") return snapshot()
      if (method === "sideChat/send") return sending.promise
      return {}
    })
    const original = {
      id: "excerpt-1",
      kind: "annotation" as const,
      anchor: { startOffset: 0, endOffset: 15 },
      text: "const value = 1",
      comment: "Why?",
      source: {
        kind: "file" as const,
        label: "example.ts",
        path: "/repo/example.ts",
      },
    }
    useWorkspaceStore
      .getState()
      .updateChatDraft("chat-tab", inputParts("Explain"), [original])
    const user = userEvent.setup()
    render(<Panel />)
    await user.click(
      screen.getByRole("button", { name: "Send side chat message" }),
    )
    expect(requests("sideChat/send")[0]).toMatchObject({
      content: inputFixture(
        inputParts("Explain"),
        { references: [original] }.references,
      ),
    })
    await act(async () =>
      useWorkspaceStore.getState().askInSideChat(
        {
          id: "excerpt-2",
          kind: "selection",
          text: "new context",
          source: { kind: "message", label: "New response" },
        },
        "main-session",
      ),
    )
    await act(async () => sending.resolve(acceptedSnapshot(1)))
    expect(screen.queryByRole("alert")).toBeNull()
    expect(
      useWorkspaceStore.getState().tabs.find((tab) => tab.id === "chat-tab"),
    ).toMatchObject({
      excerpts: [original, expect.objectContaining({ id: "excerpt-2" })],
    })
    expect(
      (
        screen.getByRole("textbox", {
          name: "Message side chat",
        }) as HTMLElement
      ).textContent,
    ).toBe("Explain")
    expect(useAppStore.getState().promptDraft).toEqual(
      inputParts("Main conversation draft"),
    )
  })

  it("uploads images to the temporary chat and retains them across a failed admission", async () => {
    const image = {
      type: "image" as const,
      name: "diagram.png",
      mediaType: "image/png" as const,
      sizeBytes: 20,
      width: 4,
      height: 5,
      detail: "high" as const,
      file: {
        rolloutId: "side-chat",
        path: "attachments/staging/images/diagram.png",
      },
    }
    const importAttachmentFiles = vi.fn(async () => [image])
    const discardDraftAttachments = vi.fn(async () => {})
    Object.defineProperty(window, "yakitoriDesktop", {
      configurable: true,
      value: { importAttachmentFiles, discardDraftAttachments },
    })
    client.request.mockImplementation(async (method) => {
      if (method === "sideChat/create") return snapshot()
      if (method === "sideChat/send") throw new Error("Connection lost")
      return {}
    })
    const user = userEvent.setup()
    render(<Panel />)
    const editor = screen.getByRole("textbox", { name: "Message side chat" })
    const file = new File(["image"], "diagram.png", { type: "image/png" })
    fireEvent.paste(editor, {
      clipboardData: {
        files: [file],
        items: [{ kind: "file", type: file.type, getAsFile: () => file }],
        getData: () => "",
      },
    })
    await screen.findByRole("button", { name: "Preview diagram.png" })
    expect(importAttachmentFiles).toHaveBeenCalledWith({
      sessionId: "side-chat",
      files: [file],
    })
    await user.click(
      screen.getByRole("button", { name: "Send side chat message" }),
    )
    await screen.findByRole("alert")
    expect(requests("sideChat/send")[0]).toMatchObject({
      content: inputFixture(inputParts("Explain", [image])),
    })
    expect(
      screen.getByRole("button", { name: "Preview diagram.png" }),
    ).toBeDefined()
    await user.click(
      screen.getByRole("button", { name: "Send side chat message" }),
    )
    expect(requests("sideChat/send")[1]).toEqual(requests("sideChat/send")[0])
    expect(
      (useAppStore.getState().promptDraft?.attachments ?? []).filter(
        (attachment) => attachment.mediaType !== "application/pdf",
      ),
    ).toEqual(inputParts("").attachments)
    expect(useAppStore.getState().promptDraft).toEqual(
      inputParts("Main conversation draft"),
    )
  })

  it("shares skill insertion and prompt history without crossing composer state", async () => {
    const skill = {
      name: "review",
      description: "Review changes",
      path: "/repo/review/SKILL.md",
      scope: "repo" as const,
    }
    useAppStore.setState({ sessionSkills: [skill] })
    client.request.mockImplementation(async (method) => {
      if (method === "sideChat/create") return snapshot()
      if (method === "sideChat/send") return acceptedSnapshot(1)
      return {}
    })
    const user = userEvent.setup()
    render(
      <>
        <Composer />
        <Panel />
      </>,
    )
    await user.click(
      screen.getByRole("button", { name: "Send side chat message" }),
    )
    const editor = screen.getByRole("textbox", { name: "Message side chat" })
    await waitFor(() => expect(editor.textContent).toBe(""))
    expect(editor.getAttribute("contenteditable")).toBe("true")
    await pastePrompt(editor, "new draft", true)
    await user.click(editor)
    await selectPrompt(editor, 0)
    fireEvent.keyDown(editor, { key: "ArrowUp" })
    expect(editor.textContent).toBe("Explain")
    fireEvent.keyDown(editor, { key: "ArrowDown" })
    expect(editor.textContent).toBe("new draft")
    await pastePrompt(editor, "$rev", true)
    await user.keyboard("{Enter}")
    expect(editor.textContent).toContain("review")
    const side = useWorkspaceStore
      .getState()
      .tabs.find((tab) => tab.id === "chat-tab")
    expect(side?.kind === "chat" && side.draft).toMatchObject({
      text: expect.stringContaining("/repo/review/SKILL.md"),
    })
    expect(useAppStore.getState().promptDraft).toEqual(
      inputParts("Main conversation draft"),
    )
    expect(requests("sideChat/send")).toHaveLength(1)
  })

  it("resolves tool permission requests in the side session", async () => {
    const permission = {
      permissionRequestId: "permission-side",
      sessionId: "side-chat",
      turnId: "turn-side",
      toolCallId: "call-side",
      action: "write",
      subject: "/repo/file",
      reason: "Requested edit",
      createdAt: "2026-09-20T00:00:00.000Z",
    }
    client.request.mockImplementation(async (method) => {
      if (method === "sideChat/create") return snapshot()
      if (method === "sideChat/send")
        return acceptedSnapshot(1, {
          activeTurnId: "turn-side",
          pendingPermissions: [permission],
        })
      if (method === "sideChat/resolvePermission")
        return snapshot(2, {
          activeTurnId: "turn-side",
          pendingPermissions: [],
        })
      return {}
    })
    const user = userEvent.setup()
    render(<Panel />)
    await user.click(
      screen.getByRole("button", { name: "Send side chat message" }),
    )
    await user.click(await screen.findByRole("button", { name: "Allow" }))
    expect(requests("sideChat/resolvePermission")).toEqual([
      {
        sideChatId: "side-chat",
        turnId: "turn-side",
        permissionRequestId: "permission-side",
        behavior: "allow",
      },
    ])
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull()
    expect(useAppStore.getState().promptDraft).toEqual(
      inputParts("Main conversation draft"),
    )
  })

  it("captures the parent on opening and changes retry identity when context changes", async () => {
    client.request.mockImplementation(async (method) => {
      if (method === "sideChat/create") return snapshot()
      if (method === "sideChat/send") throw new Error("Connection lost")
      return {}
    })
    const user = userEvent.setup()
    render(<Panel />)
    await act(async () =>
      useAppStore.setState({
        selection: { sessionId: "other-main" },
        modelSelections: { "other-main": modelB },
      }),
    )
    await user.click(
      screen.getByRole("button", { name: "Send side chat message" }),
    )
    expect(requests("sideChat/create")).toEqual([
      { cwd: "/repo", sourceSessionId: "main-session", modelSelection: modelA },
    ])
    await screen.findByRole("alert")
    const original = requests("sideChat/send")[0]
    const context = {
      id: "later-context",
      kind: "selection" as const,
      text: "More context",
      source: { kind: "message" as const, label: "Response" },
    }
    await act(async () =>
      useWorkspaceStore
        .getState()
        .updateChatDraft("chat-tab", inputParts("Explain"), [context]),
    )
    await user.click(
      screen.getByRole("button", { name: "Send side chat message" }),
    )
    expect(requests("sideChat/send")[1]).toMatchObject({
      content: inputFixture(
        inputParts("Explain"),
        { references: [context] }.references,
      ),
    })
    expect(requests("sideChat/send")[1]?.requestId).not.toBe(
      original?.requestId,
    )
  })
})
