import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { createRolloutAssets } from "../../src/core/rollout-assets.ts"
import {
  BrowserControlError,
  type BrowserRequest,
} from "../../src/protocol/desktop-browser.ts"
import { isJsonObject } from "../../src/protocol/json.ts"
import { createBrowserDownloadTool } from "../../src/server/browser-download-tool.ts"

const target = {
    tabId: "owned",
    webContentsId: 17,
    instanceId: "browser_target_00000000-0000-4000-8000-000000000001",
  },
  downloadId = "browser_download_00000000-0000-4000-8000-000000000001"
const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function fixture(
  options: {
    releaseUnknown?: boolean
    changedSize?: boolean
    cancelDuringRead?: boolean
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "yakitori-download-tool-")),
    path = join(root, "native-file"),
    bytes = Buffer.from([0, 255, 1, 2, 3])
  roots.push(root)
  await writeFile(path, bytes)
  await mkdir(join(root, "assets/rollouts/rollout_download"), {
    recursive: true,
  })
  const assets = createRolloutAssets(join(root, "assets"), {
      withMutationLease: async (_id, mutate) => mutate(),
    }),
    originalSave = assets.saveToolFile,
    requests: BrowserRequest[] = [],
    signal = new AbortController(),
    cancelReason = new Error("Stop before download persistence")
  let savedPath: string | undefined,
    marks = 0,
    admitted = true
  assets.saveToolFile = async (...args) => {
    const saved = await originalSave(...args)
    savedPath = saved.path
    return saved
  }
  const tool = createBrowserDownloadTool(
    {
      async request(input, owner) {
        expect(owner).toEqual({ sessionId: "session", turnId: "turn" })
        requests.push(input)
        if (input.action === "download_collect") {
          if (options.cancelDuringRead) signal.abort(cancelReason)
          return {
            state: "completed",
            path,
            filename: "../../report-你好.bin",
            size: options.changedSize ? 6 : 5,
          }
        }
        if (input.action === "download_release") {
          if (!savedPath)
            throw new Error("Scratch release preceded artifact persistence")
          expect(await readFile(savedPath)).toEqual(bytes)
          if (options.releaseUnknown)
            throw new BrowserControlError(
              "browser_cleanup_failed",
              "Native release completion unknown",
            )
          await rm(path)
          return { released: true }
        }
        return { downloadId, state: "armed" }
      },
      async finishTurn() {},
      async closeSession() {},
    },
    async () =>
      admitted
        ? undefined
        : {
            ok: false,
            code: "computer_taken_over",
            message: "Taken over",
            content: "Taken over",
          },
    () => {
      marks++
    },
  )
  return {
    tool,
    requests,
    path,
    root,
    bytes,
    cancelReason,
    context: {
      workspaceRoot: root,
      threadId: "session",
      turnId: "turn",
      rolloutId: "rollout_download",
      toolCallId: "tool_collect",
      rolloutAssets: assets,
      signal: signal.signal,
    },
    get marks() {
      return marks
    },
    refuse: () => {
      admitted = false
    },
  }
}

it("persists exact binary bytes and their checksum before deleting native scratch data", async () => {
  const f = await fixture(),
    result = await f.tool.execute(
      { action: "collect", target, downloadId },
      f.context,
    )
  expect(result).toMatchObject({
    ok: true,
    output: {
      downloadId,
      byteLength: 5,
      filename: "../../report-你好.bin",
      sha256:
        "4be72cf29a33b5f223067ab9d5dd9567e0c14978e6ed54e2d556ddc9e2cc6038",
    },
  })
  if (
    !result.ok ||
    !isJsonObject(result.output) ||
    typeof result.output.path !== "string"
  )
    throw new Error("Missing persisted download path")
  expect(await readFile(result.output.path)).toEqual(f.bytes)
  expect(result.output.path).not.toBe(f.path)
  expect(result.output.path).not.toContain("report-")
  expect(f.requests.map((request) => request.action)).toEqual([
    "download_collect",
    "download_release",
  ])
  await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" })
})

it("keeps an already persisted file recoverable when native scratch cleanup is unconfirmed", async () => {
  const f = await fixture({ releaseUnknown: true }),
    result = await f.tool.execute(
      { action: "collect", target, downloadId },
      f.context,
    )
  expect(result).toMatchObject({
    ok: false,
    code: "browser_cleanup_failed",
    output: { byteLength: 5 },
  })
  if (
    result.ok ||
    !isJsonObject(result.output) ||
    typeof result.output.path !== "string"
  )
    throw new Error("Missing recovery file path")
  expect(await readFile(result.output.path)).toEqual(f.bytes)
  expect(result.content).toContain("do not download it again")
  expect(f.marks).toBe(1)
  expect(f.requests.map((request) => request.action)).toEqual([
    "download_collect",
    "download_release",
  ])
})

it("does not release native data when its declared file changed before collection", async () => {
  const f = await fixture({ changedSize: true })
  expect(
    await f.tool.execute({ action: "collect", target, downloadId }, f.context),
  ).toMatchObject({ ok: false, code: "browser_download_changed" })
  expect(f.requests.map((request) => request.action)).toEqual([
    "download_collect",
  ])
  expect(await readFile(f.path)).toEqual(f.bytes)
})

it("keeps collection cancellable before persistence without discarding the original native file", async () => {
  const f = await fixture({ cancelDuringRead: true })
  await expect(
    f.tool.execute({ action: "collect", target, downloadId }, f.context),
  ).rejects.toBe(f.cancelReason)
  expect(f.requests.map((request) => request.action)).toEqual([
    "download_collect",
  ])
  expect(await readFile(f.path)).toEqual(f.bytes)
})

it("requires normal command permission and shared computer admission for every download action", async () => {
  const f = await fixture()
  expect(f.tool.approvalRequirement).toMatchObject({
    kind: "approval",
    action: "command_execution",
  })
  f.refuse()
  for (const input of [
    { action: "arm", target, fromUrl: "https://owned.test/" },
    ...["status", "wait", "cancel", "collect"].map((action) => ({
      action,
      target,
      downloadId,
    })),
  ])
    expect(await f.tool.execute(input, f.context)).toMatchObject({
      ok: false,
      code: "computer_taken_over",
    })
  expect(f.requests).toEqual([])
})

it("refuses arbitrary paths, private release commands, cross-scope IDs and non-download URLs before native dispatch", async () => {
  const f = await fixture(),
    arm = { action: "arm", target, fromUrl: "https://owned.test/" }
  for (const input of [
    { ...arm, path: "/private/file" },
    { ...arm, url: "file:///private/file" },
    { ...arm, url: "javascript:alert(1)" },
    { ...arm, fromUrl: "" },
    { ...arm, frameReference: "other-frame" },
    { action: "release", target, downloadId },
    { action: "collect", target, downloadId: "other" },
  ])
    expect(await f.tool.execute(input, f.context)).toMatchObject({
      ok: false,
      code: "invalid_arguments",
    })
  expect(f.requests).toEqual([])
  for (const url of [
    "https://owned.test/start",
    "blob:https://owned.test/123",
    "data:application/octet-stream;base64,YWJj",
  ])
    expect(await f.tool.execute({ ...arm, url }, f.context)).toMatchObject({
      ok: true,
    })
  expect(f.requests.map((request) => request.action)).toEqual([
    "download_arm",
    "download_arm",
    "download_arm",
  ])
})
