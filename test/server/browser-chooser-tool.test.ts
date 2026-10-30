import { expect, it } from "vitest"
import {
  BrowserControlError,
  type BrowserRequest,
  browserRequestMutates,
  parseBrowserRequest,
} from "../../src/protocol/desktop-browser.ts"
import { createBrowserChooserTool } from "../../src/server/browser-chooser-tool.ts"

const target = {
    tabId: "owned",
    webContentsId: 17,
    instanceId: "browser_target_00000000-0000-4000-8000-000000000001",
  },
  context = { workspaceRoot: "/workspace", threadId: "session", turnId: "turn" }
it("requires shared computer admission and normal command permission for chooser configuration and inspection", async () => {
  const requests: BrowserRequest[] = []
  let admitted = false
  const tool = createBrowserChooserTool(
    {
      async request(request, owner) {
        expect(owner).toEqual({ sessionId: "session", turnId: "turn" })
        requests.push(request)
        return { armed: request.action !== "chooser_disarm" }
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
    () => {},
  )
  expect(tool.approvalRequirement).toMatchObject({
    kind: "approval",
    action: "command_execution",
  })
  const arm = { action: "arm", target, fromUrl: "https://owned.test/" }
  expect(await tool.execute(arm, context)).toMatchObject({
    ok: false,
    code: "computer_taken_over",
  })
  expect(requests).toEqual([])
  admitted = true
  for (const input of [
    arm,
    { action: "inspect", target },
    { action: "disarm", target },
  ])
    expect(await tool.execute(input, context)).toMatchObject({ ok: true })
  expect(requests).toEqual([
    { action: "chooser_arm", target, fromUrl: "https://owned.test/" },
    { action: "chooser_inspect", target },
    { action: "chooser_disarm", target },
  ])
  expect(browserRequestMutates(parseBrowserRequest(requests[0]))).toBe(true)
  expect(browserRequestMutates(parseBrowserRequest(requests[1]))).toBe(false)
  expect(browserRequestMutates(parseBrowserRequest(requests[2]))).toBe(true)
  for (const invalid of [
    { action: "arm", target },
    { ...arm, backendNodeId: 17 },
    { ...arm, paths: ["/private/file"] },
    { ...arm, fromUrl: "x".repeat(8193) },
    { action: "inspect", target, fromUrl: "https://other.test/" },
  ])
    expect(await tool.execute(invalid, context)).toMatchObject({
      ok: false,
      code: "invalid_arguments",
    })
  expect(requests).toHaveLength(3)
})
it("marks all computer input for cleanup when configuration acknowledgement is unknown", async () => {
  let marks = 0
  const tool = createBrowserChooserTool(
    {
      async request() {
        throw new BrowserControlError(
          "browser_cleanup_failed",
          "Unknown configuration",
        )
      },
      async finishTurn() {},
      async closeSession() {},
    },
    async () => undefined,
    () => {
      marks++
    },
  )
  expect(
    await tool.execute({ action: "disarm", target }, context),
  ).toMatchObject({ ok: false, code: "browser_cleanup_failed" })
  expect(marks).toBe(1)
})
