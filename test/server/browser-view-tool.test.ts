import { expect, it } from "vitest"
import {
  BrowserControlError,
  type BrowserRequest,
  browserRequestMutates,
  parseBrowserRequest,
} from "../../src/protocol/desktop-browser.ts"
import { createBrowserViewTool } from "../../src/server/browser-view-tool.ts"

const input = {
  action: "show",
  target: {
    tabId: "owned",
    webContentsId: 17,
    instanceId: "browser_target_00000000-0000-4000-8000-000000000001",
  },
  fromUrl: "https://owned.test/",
}
const context = {
  workspaceRoot: "/workspace",
  threadId: "session",
  turnId: "turn",
}
it("gates explicit display behind normal permission and shared computer ownership with an exact target", async () => {
  const requests: BrowserRequest[] = []
  let admitted = false
  const tool = createBrowserViewTool(
    {
      request: async (request, owner) => {
        expect(owner).toEqual({ sessionId: "session", turnId: "turn" })
        requests.push(request)
        return { selectionApplied: true, visible: true }
      },
      finishTurn: async () => {},
      closeSession: async () => {},
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
  if (typeof tool.approvalRequirement !== "function")
    throw new Error("Missing display permission")
  expect(await tool.approvalRequirement(input, context)).toMatchObject({
    kind: "approval",
    action: "command_execution",
    subject: expect.stringContaining("https://owned.test/"),
  })
  expect(await tool.execute(input, context)).toMatchObject({
    ok: false,
    code: "computer_taken_over",
  })
  expect(requests).toEqual([])
  admitted = true
  expect(await tool.execute(input, context)).toMatchObject({
    ok: true,
    output: { selectionApplied: true, visible: true },
  })
  expect(requests).toEqual([input])
  expect(browserRequestMutates(parseBrowserRequest(input))).toBe(true)
  for (const extra of [
    { foreground: true },
    { requestId: "caller" },
    { result: "applied" },
    { action: "claim" },
    { fromUrl: "x".repeat(8193) },
  ])
    expect(() => parseBrowserRequest({ ...input, ...extra })).toThrow()
})
it("preserves unconfirmed display cleanup so all computer input remains quarantined", async () => {
  let marks = 0
  const tool = createBrowserViewTool(
    {
      request: async () => {
        throw new BrowserControlError(
          "browser_cleanup_failed",
          "Renderer acknowledgement missing",
        )
      },
      finishTurn: async () => {},
      closeSession: async () => {},
    },
    async () => undefined,
    () => {
      marks++
    },
  )
  expect(await tool.execute(input, context)).toMatchObject({
    ok: false,
    code: "browser_cleanup_failed",
  })
  expect(marks).toBe(1)
})
