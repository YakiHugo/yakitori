import {
  mkdtemp,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import {
  type BrowserRequest,
  browserRequestMutates,
  parseBrowserRequest,
} from "../../src/protocol/desktop-browser.ts"
import { createBrowserUploadTool } from "../../src/server/browser-upload-tool.ts"

const target = {
  tabId: "owned",
  webContentsId: 1,
  instanceId: "browser_target_00000000-0000-4000-8000-000000000001",
}
const input = {
  action: "upload",
  target,
  reference: "browser_element_00000000-0000-4000-8000-000000000001",
  fromUrl: "https://owned.test/",
  paths: ["file.txt"],
}

it("resolves regular upload files to canonical metadata and identifies disclosure in the normal permission request", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "yakitori-upload-test-")),
  )
  const requests: BrowserRequest[] = []
  const tool = createBrowserUploadTool(
    {
      request: async (request) => {
        requests.push(request)
        return { filesVerified: true }
      },
      finishTurn: async () => {},
      closeSession: async () => {},
    },
    async () => undefined,
    () => {},
  )
  try {
    await writeFile(join(root, "file.txt"), "hello")
    await utimes(join(root, "file.txt"), 1700000000, 1700000000)
    const context = { workspaceRoot: root, threadId: "session", turnId: "turn" }
    expect(typeof tool.approvalRequirement).toBe("function")
    if (typeof tool.approvalRequirement !== "function")
      throw new Error("Missing disclosure permission")
    expect(await tool.approvalRequirement(input, context)).toMatchObject({
      kind: "approval",
      action: "command_execution",
      subject: "Provide local files to https://owned.test/",
      reason: expect.stringContaining("file.txt"),
    })
    expect(await tool.execute(input, context)).toMatchObject({
      ok: true,
      output: { filesVerified: true },
    })
    expect(requests).toEqual([
      {
        action: "upload",
        target,
        reference: input.reference,
        fromUrl: input.fromUrl,
        files: [
          {
            path: join(root, "file.txt"),
            name: "file.txt",
            size: 5,
            lastModified: 1700000000000,
          },
        ],
      },
    ])
    const parsed = parseBrowserRequest(requests[0])
    expect(browserRequestMutates(parsed)).toBe(true)
    expect(await tool.execute({ ...input, paths: [] }, context)).toMatchObject({
      ok: true,
    })
    expect(requests.at(-1)).toMatchObject({ action: "upload", files: [] })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("refuses directories, missing files and duplicate aliases without asking Chromium to read them", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "yakitori-upload-test-")),
  )
  const requests: BrowserRequest[] = []
  const tool = createBrowserUploadTool(
    {
      request: async (request) => {
        requests.push(request)
        return {}
      },
      finishTurn: async () => {},
      closeSession: async () => {},
    },
    async () => undefined,
    () => {},
  )
  try {
    await writeFile(join(root, "file.txt"), "hello")
    await symlink(join(root, "file.txt"), join(root, "alias.txt"))
    for (const paths of [["."], ["missing.txt"], ["file.txt", "alias.txt"]])
      expect(
        await tool.execute(
          { ...input, paths },
          { workspaceRoot: root, threadId: "session", turnId: "turn" },
        ),
      ).toMatchObject({ ok: false })
    expect(requests).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("checks shared computer admission before resolving local paths and rejects model-supplied transport metadata", async () => {
  const tool = createBrowserUploadTool(
    {
      request: async () => {
        throw new Error("No browser request allowed")
      },
      finishTurn: async () => {},
      closeSession: async () => {},
    },
    async () => ({
      ok: false,
      code: "computer_taken_over",
      message: "Taken over",
      content: "Taken over",
    }),
    () => {},
  )
  const context = {
    workspaceRoot: "/missing-workspace",
    threadId: "session",
    turnId: "turn",
  }
  expect(await tool.execute(input, context)).toMatchObject({
    ok: false,
    code: "computer_taken_over",
  })
  for (const extra of [
    { files: [] },
    { paths: [""] },
    { paths: ["a\0b"] },
    { paths: Array.from({ length: 257 }, () => "file.txt") },
    { paths: ["x".repeat(8193)] },
  ])
    expect(await tool.execute({ ...input, ...extra }, context)).toMatchObject({
      ok: false,
      code: "invalid_arguments",
    })
  for (const files of [
    [{ path: "relative", name: "file.txt", size: 1, lastModified: 1 }],
    [{ path: "/file", name: "../secret", size: 1, lastModified: 1 }],
    [{ path: "/file", name: "file", size: -1, lastModified: 1 }],
    [{ path: "/file", name: "file", size: 1, lastModified: 1.5 }],
  ])
    expect(() =>
      parseBrowserRequest({
        action: "upload",
        target,
        reference: input.reference,
        fromUrl: input.fromUrl,
        files,
      }),
    ).toThrow()
})
