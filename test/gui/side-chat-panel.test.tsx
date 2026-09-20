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
import type { SideChatSnapshot } from "../../src/server/side-chat.ts"
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
    messages: [],
    ...extra,
  }
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
    promptDraft: "Main conversation draft",
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
        draft: "Explain",
        excerpts: [],
        attachments: [],
        sourceSessionId: "main-session",
      },
    ],
    activeId: "chat-tab",
  })
})

afterEach(() => {
  cleanup()
  useWorkspaceStore.setState({ tabs: [], activeId: undefined })
  useAppStore.setState(createInitialAppState())
})

describe("side chat panel", () => {
  it("creates its fork on mount without sending and reuses pending creation for the first send", async () => {
    const creating = deferred<SideChatSnapshot>()
    client.request.mockImplementation(async (method) => {
      if (method === "sideChat/create") return creating.promise
      if (method === "sideChat/send") return snapshot(1)
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
      draft: "Explain",
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
      text: "Explain",
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
    await act(async () => sending.resolve(snapshot(1)))
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
    expect(changed).toMatchObject({ text: "Explain", modelSelection: modelB })
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
    expect(useAppStore.getState().promptDraft).toBe("Main conversation draft")
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
      .updateChatDraft("chat-tab", "Explain", [original])
    const user = userEvent.setup()
    render(<Panel />)
    await user.click(
      screen.getByRole("button", { name: "Send side chat message" }),
    )
    expect(requests("sideChat/send")[0]).toMatchObject({
      text: "Explain",
      contextAttachments: [original],
      attachments: [],
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
    await act(async () => sending.resolve(snapshot(1)))
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
    expect(useAppStore.getState().promptDraft).toBe("Main conversation draft")
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
      file: { rolloutId: "side-chat", path: "images/diagram.png" },
    }
    const importImageFiles = vi.fn(async () => [image])
    const discardDraftImages = vi.fn(async () => {})
    Object.defineProperty(window, "yakitoriDesktop", {
      configurable: true,
      value: { importImageFiles, discardDraftImages },
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
    expect(importImageFiles).toHaveBeenCalledWith({
      sessionId: "side-chat",
      files: [file],
    })
    await user.click(
      screen.getByRole("button", { name: "Send side chat message" }),
    )
    await screen.findByRole("alert")
    expect(requests("sideChat/send")[0]).toMatchObject({
      text: "Explain",
      attachments: [image],
    })
    expect(
      screen.getByRole("button", { name: "Preview diagram.png" }),
    ).toBeDefined()
    await user.click(
      screen.getByRole("button", { name: "Send side chat message" }),
    )
    expect(requests("sideChat/send")[1]).toEqual(requests("sideChat/send")[0])
    expect(useAppStore.getState().promptAttachments).toEqual([])
    expect(useAppStore.getState().promptDraft).toBe("Main conversation draft")
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
      if (method === "sideChat/send")
        return snapshot(1, {
          messages: [
            {
              id: "input",
              turnId: "turn",
              role: "user",
              text: "Explain",
              streaming: false,
            },
          ],
        })
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
    expect(side?.kind === "chat" && side.draft).toContain(
      "/repo/review/SKILL.md",
    )
    expect(useAppStore.getState().promptDraft).toBe("Main conversation draft")
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
        return snapshot(1, {
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
    expect(useAppStore.getState().promptDraft).toBe("Main conversation draft")
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
        .updateChatDraft("chat-tab", "Explain", [context]),
    )
    await user.click(
      screen.getByRole("button", { name: "Send side chat message" }),
    )
    expect(requests("sideChat/send")[1]).toMatchObject({
      text: "Explain",
      contextAttachments: [context],
    })
    expect(requests("sideChat/send")[1]?.requestId).not.toBe(
      original?.requestId,
    )
  })
})
