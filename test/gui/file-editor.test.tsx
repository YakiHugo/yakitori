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
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { WorkspaceFilePreview } from "../../src/gui/components/workspace-files.tsx"
import { ApiRequestError } from "../../src/gui/lib/rpc-client.ts"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("../../src/gui/lib/rpc-client.ts", async (original) => ({
  ...(await original<typeof import("../../src/gui/lib/rpc-client.ts")>()),
  getAppRpcClient: () => ({ request }),
}))
// The editor widget is covered in Chromium. These tests exercise the file
// lifecycle and RPC contract without mocking the save/conflict controller.
vi.mock("../../src/gui/components/code-editor.tsx", () => ({
  CodeEditor: ({
    value,
    onChange,
  }: {
    value: string
    onChange(value: string): void
  }) => (
    <textarea
      aria-label="Editor"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}))
beforeEach(() => {
  useAppStore.setState(createInitialAppState())
  request.mockReset()
  request.mockImplementation(async (method) =>
    method === "workspace/read"
      ? {
          path: "notes.txt",
          content: "partial preview",
          offset: 1,
          truncated: true,
          binary: false,
        }
      : {
          path: "notes.txt",
          content: "whole file\nlast line\n",
          sha256: "original-sha",
        },
  )
})
afterEach(() => {
  cleanup()
  useAppStore.setState(createInitialAppState())
})

it("edits the complete file and keeps the draft across focus and agent turn updates", async () => {
  const user = userEvent.setup()
  render(
    <WorkspaceFilePreview
      cwd="/repo"
      path="notes.txt"
      apiBase="http://local"
    />,
  )
  await user.click(await screen.findByRole("button", { name: "Edit file" }))
  const editor = (await screen.findByRole("textbox", {
    name: "Editor",
  })) as HTMLTextAreaElement
  expect(editor.value).toBe("whole file\nlast line\n")
  fireEvent.change(editor, { target: { value: "my unsaved draft\n" } })
  act(() => {
    window.dispatchEvent(new Event("focus"))
    useAppStore.setState((state) => ({
      execution: { ...state.execution, activeTurnId: "new-turn" },
    }))
  })
  expect(editor.value).toBe("my unsaved draft\n")
  expect(screen.getByText("Unsaved changes")).toBeDefined()
  const closing = new Event("beforeunload", { cancelable: true })
  window.dispatchEvent(closing)
  expect(closing.defaultPrevented).toBe(true)
  request.mockResolvedValueOnce({ path: "notes.txt", sha256: "next-sha" })
  await user.click(screen.getByRole("button", { name: "Save" }))
  await screen.findByText("Saved")
  expect(request).toHaveBeenLastCalledWith("workspace/write", {
    cwd: "/repo",
    path: "notes.txt",
    content: "my unsaved draft\n",
    expectedSha256: "original-sha",
  })
  const cleanClose = new Event("beforeunload", { cancelable: true })
  window.dispatchEvent(cleanClose)
  expect(cleanClose.defaultPrevented).toBe(false)
})

it("keeps edits typed during a save dirty and uses the returned revision next time", async () => {
  const user = userEvent.setup()
  let finish!: (value: { path: string; sha256: string }) => void
  render(
    <WorkspaceFilePreview
      cwd="/repo"
      path="notes.txt"
      apiBase="http://local"
    />,
  )
  await user.click(await screen.findByRole("button", { name: "Edit file" }))
  const editor = await screen.findByRole("textbox", { name: "Editor" })
  fireEvent.change(editor, { target: { value: "first" } })
  request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await user.click(screen.getByRole("button", { name: "Save" }))
  fireEvent.change(editor, { target: { value: "second" } })
  await act(async () => finish({ path: "notes.txt", sha256: "saved-first" }))
  expect(screen.getByText("Unsaved changes")).toBeDefined()
  request.mockResolvedValueOnce({ path: "notes.txt", sha256: "saved-second" })
  await user.click(screen.getByRole("button", { name: "Save" }))
  await screen.findByText("Saved")
  expect(request).toHaveBeenLastCalledWith("workspace/write", {
    cwd: "/repo",
    path: "notes.txt",
    content: "second",
    expectedSha256: "saved-first",
  })
})

it("preserves a conflicting draft and reloads only after explicit discard", async () => {
  const user = userEvent.setup()
  render(
    <WorkspaceFilePreview
      cwd="/repo"
      path="notes.txt"
      apiBase="http://local"
    />,
  )
  await user.click(await screen.findByRole("button", { name: "Edit file" }))
  const editor = (await screen.findByRole("textbox", {
    name: "Editor",
  })) as HTMLTextAreaElement
  fireEvent.change(editor, { target: { value: "local edit" } })
  request.mockRejectedValueOnce(new ApiRequestError("changed", "conflict"))
  await user.click(screen.getByRole("button", { name: "Save" }))
  expect((await screen.findByRole("alert")).textContent).toContain(
    "changed on disk",
  )
  expect(editor.value).toBe("local edit")
  expect(
    (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true)
  request.mockResolvedValueOnce({
    path: "notes.txt",
    content: "external edit",
    sha256: "external",
  })
  await user.click(
    screen.getByRole("button", { name: "Reload and discard edits" }),
  )
  await waitFor(() =>
    expect(
      (screen.getByRole("textbox", { name: "Editor" }) as HTMLTextAreaElement)
        .value,
    ).toBe("external edit"),
  )
  expect(screen.queryByText("Unsaved changes")).toBeNull()
})
