// @vitest-environment happy-dom
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { MarkdownView } from "../../src/gui/components/markdown.tsx"
import { readWorkspaceMediaFile } from "../../src/server/workspace.ts"

const { request } = vi.hoisted(() => ({
  request:
    vi.fn<
      (
        method: string,
        params: { cwd: string; path: string },
      ) => Promise<unknown>
    >(),
}))
vi.mock("../../src/gui/lib/rpc-client.ts", () => ({
  getAppRpcClient: () => ({ request }),
}))

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jqWQAAAAASUVORK5CYII="
let root: string
let cwd: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "yakitori-markdown-images-"))
  cwd = join(root, "project")
  await mkdir(join(cwd, "docs", "assets"), { recursive: true })
  await mkdir(join(cwd, "images"))
  await writeFile(
    join(cwd, "docs", "assets", "chart one.png"),
    Buffer.from(png, "base64"),
  )
  await writeFile(join(cwd, "images", "chart.png"), Buffer.from(png, "base64"))
  request.mockReset()
  request.mockImplementation(async (method, params) => {
    expect(method).toBe("workspace/readMedia")
    return readWorkspaceMediaFile(params)
  })
})
afterEach(async () => {
  cleanup()
  await rm(root, { recursive: true, force: true })
})

it("renders actual workspace bytes from relative, absolute, file-URL and README image sources", async () => {
  const chart = join(cwd, "docs", "assets", "chart one.png")
  const cases = [
    { source: "docs/assets/chart%20one.png" },
    { source: chart.replaceAll(" ", "%20") },
    { source: pathToFileURL(chart).href },
    {
      source: "./assets/chart%20one.png",
      documentPath: join(cwd, "docs", "README.md"),
    },
    {
      source: "../images/chart.png",
      documentPath: join(cwd, "docs", "README.md"),
    },
  ]
  for (const { source, documentPath } of cases) {
    const { unmount } = render(
      <MarkdownView
        text={`![Actual chart](${source})`}
        workspaceRoot={cwd}
        documentPath={documentPath}
      />,
    )
    expect(
      (await screen.findByRole("img", { name: "Actual chart" })).getAttribute(
        "src",
      ),
    ).toBe(`data:image/png;base64,${png}`)
    unmount()
  }
  expect(request).toHaveBeenCalledTimes(5)
})

it("keeps the real workspace containment boundary for parent paths, outside absolute paths and symlinks", async () => {
  const outside = join(root, "outside.png")
  await writeFile(outside, Buffer.from(png, "base64"))
  await symlink(outside, join(cwd, "escape.png"))
  await mkdir(join(cwd, ".git"))
  await writeFile(join(cwd, ".git", "private.png"), Buffer.from(png, "base64"))
  for (const source of [
    "../outside.png",
    pathToFileURL(outside).href,
    "escape.png",
    ".git/private.png",
  ]) {
    const { unmount } = render(
      <MarkdownView text={`![Outside](${source})`} workspaceRoot={cwd} />,
    )
    await screen.findByText("Image unavailable · Outside")
    expect(screen.queryByRole("img")).toBeNull()
    unmount()
  }
  // The explicit outside file URL is rejected before a read; every actual read
  // still uses the caller's root and is rejected by the filesystem boundary.
  expect(request).toHaveBeenCalledTimes(3)
  for (const [, params] of request.mock.calls) expect(params.cwd).toBe(cwd)
})
