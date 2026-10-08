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
import { conversationFindRanges } from "../../src/gui/components/conversation-find-text.ts"
import { MarkdownView } from "../../src/gui/components/markdown.tsx"
import { useAppStore } from "../../src/gui/store/app-store.ts"

const { request, getClient } = vi.hoisted(() => {
  const request =
    vi.fn<
      (method: string, params: Record<string, unknown>) => Promise<unknown>
    >()
  return { request, getClient: vi.fn(() => ({ request })) }
})
vi.mock("../../src/gui/lib/rpc-client.ts", () => ({
  getAppRpcClient: getClient,
}))

beforeEach(() => {
  request.mockReset()
  getClient.mockClear()
  request.mockResolvedValue({
    path: "diagram.png",
    mimeType: "image/png",
    base64: "aW1hZ2U=",
  })
  useAppStore.setState({ apiBase: "http://localhost:9999" })
})
afterEach(cleanup)

it.each([
  ["./figures/chart%20one.png", "./figures/chart one.png"],
  ["/repo/figures/chart.png", "figures/chart.png"],
  ["file:///repo/figures/chart%20one.png", "figures/chart one.png"],
])("loads workspace image %s through the workspace media boundary", async (source, path) => {
  render(<MarkdownView text={`![Chart](${source})`} workspaceRoot="/repo" />)
  const image = await screen.findByRole("img", { name: "Chart" })
  await waitFor(() =>
    expect(image.getAttribute("src")).toBe("data:image/png;base64,aW1hZ2U="),
  )
  expect(request).toHaveBeenCalledExactlyOnceWith("workspace/readMedia", {
    cwd: "/repo",
    path,
  })
})

it("resolves README images from the document directory within the original workspace", async () => {
  render(
    <MarkdownView
      text="![Chart](../images/chart.png?raw=true#section)"
      workspaceRoot="/repo"
      documentPath="/repo/docs/README.md"
    />,
  )
  await waitFor(() =>
    expect(request).toHaveBeenCalledExactlyOnceWith("workspace/readMedia", {
      cwd: "/repo",
      path: "images/chart.png",
    }),
  )
  expect(
    (await screen.findByRole("img", { name: "Chart" })).getAttribute("src"),
  ).toBe("data:image/png;base64,aW1hZ2U=#section")
})

it.each([
  "https://example.com/chart.png",
  "http://localhost:8080/chart.png",
  "//example.com/chart.png",
  "data:image/png;base64,aW1hZ2U=",
  "data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22/%3E",
])("keeps browser-displayable image source %s", (source) => {
  render(<MarkdownView text={`![Chart](${source})`} workspaceRoot="/repo" />)
  expect(screen.getByRole("img", { name: "Chart" }).getAttribute("src")).toBe(
    source,
  )
  expect(request).not.toHaveBeenCalled()
})

it.each([
  "data:text/html;base64,PHNjcmlwdD4=",
  "javascript:alert%281%29",
  "file://server/share/chart.png",
  "#section",
])("renders an unavailable label instead of loading unsupported source %s", (source) => {
  render(<MarkdownView text={`![Chart](${source})`} workspaceRoot="/repo" />)
  expect(screen.queryByRole("img")).toBeNull()
  expect(screen.getByText("Image unavailable · Chart")).toBeTruthy()
  expect(request).not.toHaveBeenCalled()
})

it("does not turn an unscoped local image into a GUI-origin request", () => {
  render(<MarkdownView text="![Chart](chart.png)" />)
  expect(screen.queryByRole("img")).toBeNull()
  expect(screen.getByText("Image unavailable · Chart")).toBeTruthy()
  expect(request).not.toHaveBeenCalled()
})

it("reports missing workspace images and direct image decode failures", async () => {
  request.mockRejectedValue(new Error("File was not found."))
  const { rerender } = render(
    <MarkdownView text="![Chart](missing.png)" workspaceRoot="/repo" />,
  )
  expect(await screen.findByText("Image unavailable · Chart")).toBeTruthy()
  rerender(
    <MarkdownView
      text="![Chart](https://example.com/missing.png)"
      workspaceRoot="/repo"
    />,
  )
  fireEvent.error(screen.getByRole("img", { name: "Chart" }))
  expect(screen.getByText("Image unavailable · Chart")).toBeTruthy()
})

it("keeps a completed image stable across trailing stream deltas", async () => {
  const { rerender } = render(
    <MarkdownView streaming text="![Chart](chart.png" workspaceRoot="/repo" />,
  )
  expect(request).not.toHaveBeenCalled()
  rerender(
    <MarkdownView streaming text="![Chart](chart.png)" workspaceRoot="/repo" />,
  )
  const image = await screen.findByRole("img", { name: "Chart" })
  rerender(
    <MarkdownView
      streaming
      text="![Chart](chart.png)\n\nMore text"
      workspaceRoot="/repo"
    />,
  )
  expect(screen.getByRole("img", { name: "Chart" })).toBe(image)
  expect(request).toHaveBeenCalledTimes(1)
})

it("discards late bytes when the source or workspace context changes", async () => {
  let finish!: (value: unknown) => void
  request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const { rerender } = render(
    <MarkdownView text="![Chart](chart.png)" workspaceRoot="/old" />,
  )
  rerender(<MarkdownView text="![Chart](chart.png)" workspaceRoot="/new" />)
  await screen.findByRole("img", { name: "Chart" })
  await act(async () =>
    finish({ path: "chart.png", mimeType: "image/png", base64: "b2xk" }),
  )
  expect(screen.getByRole("img", { name: "Chart" }).getAttribute("src")).toBe(
    "data:image/png;base64,aW1hZ2U=",
  )
  expect(request).toHaveBeenLastCalledWith("workspace/readMedia", {
    cwd: "/new",
    path: "chart.png",
  })
})

it("uses the explicit API environment while retaining the message workspace", async () => {
  useAppStore.setState({
    execution: {
      ...useAppStore.getState().execution,
      workingDirectory: "/selected",
    },
  })
  render(
    <MarkdownView
      text="![Chart](chart.png)"
      workspaceRoot="/parked"
      apiBase="http://localhost:7777"
    />,
  )
  await screen.findByRole("img", { name: "Chart" })
  expect(getClient).toHaveBeenCalledExactlyOnceWith("http://localhost:7777")
  expect(request).toHaveBeenCalledExactlyOnceWith("workspace/readMedia", {
    cwd: "/parked",
    path: "chart.png",
  })
})

it("does not widen the workspace root for an absolute outside image", async () => {
  request.mockRejectedValue(new Error("Path escapes the workspace."))
  render(
    <MarkdownView
      text="![Chart](file:///outside/chart.png)"
      workspaceRoot="/repo"
    />,
  )
  await screen.findByText("Image unavailable · Chart")
  expect(request).not.toHaveBeenCalled()
})

it("renders a replacement source after an earlier decode failure", () => {
  const { rerender } = render(
    <MarkdownView text="![Chart](https://example.com/old.png)" />,
  )
  fireEvent.error(screen.getByRole("img", { name: "Chart" }))
  expect(screen.getByText("Image unavailable · Chart")).toBeTruthy()
  rerender(<MarkdownView text="![Chart](https://example.com/new.png)" />)
  expect(screen.getByRole("img", { name: "Chart" }).getAttribute("src")).toBe(
    "https://example.com/new.png",
  )
  expect(screen.queryByText("Image unavailable · Chart")).toBeNull()
})

it("excludes image loading and failure labels from conversation text search", async () => {
  let reject!: (error: Error) => void
  request.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail
      }),
  )
  const { container } = render(
    <MarkdownView text="Chart ![Chart](missing.png)" workspaceRoot="/repo" />,
  )
  expect(screen.getByRole("status").textContent).toContain("Chart")
  expect(conversationFindRanges(container, "Chart")).toHaveLength(1)
  await act(async () => reject(new Error("Missing image")))
  expect(screen.getByText("Image unavailable · Chart")).toBeTruthy()
  expect(conversationFindRanges(container, "Chart")).toHaveLength(1)
})
