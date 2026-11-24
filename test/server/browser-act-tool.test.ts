import { expect, it } from "vitest"
import {
  BrowserControlError,
  type BrowserRequest,
} from "../../src/protocol/desktop-browser.ts"
import { createBrowserActTool } from "../../src/server/browser-act-tool.ts"

const target = {
  tabId: "selected",
  instanceId: "browser_target_00000000-0000-4000-8000-000000000001",
  webContentsId: 17,
}
const context = {
  workspaceRoot: "/workspace",
  threadId: "session",
  turnId: "turn",
}

it("preflights all batch steps against one tab and stops at the first unconfirmed action", async () => {
  const actions: BrowserRequest[] = []
  const tool = createBrowserActTool({
    async request(request) {
      if (request.action === "target")
        return { target, url: "https://page.test" }
      actions.push(request)
      if (request.action === "click")
        throw new BrowserControlError(
          "browser_input_unconfirmed",
          "Pointer acknowledgement was lost.",
        )
      return { target, delivered: true }
    },
    async finishTurn() {},
    async closeSession() {},
  })
  const first = { action: "fill", ref: "e7", text: "value" }
  expect(
    await tool.execute(
      {
        action: "batch",
        steps: [first, { action: "click", tabId: "different", ref: "e3" }],
      },
      context,
    ),
  ).toMatchObject({ ok: false, code: "invalid_arguments" })
  expect(actions).toEqual([])
  expect(
    await tool.execute(
      {
        action: "batch",
        steps: [first, { action: "click", ref: "e3" }, first],
      },
      context,
    ),
  ).toMatchObject({
    ok: false,
    code: "browser_input_unconfirmed",
    content: expect.stringContaining('"completedSteps":1'),
  })
  expect(actions).toEqual([
    { action: "fill", target, reference: "e7", text: "value" },
    { action: "click", target, reference: "e3" },
  ])
})

it("names local-file disclosures in browser approval and refuses a context-dependent upload target", async () => {
  const tool = createBrowserActTool({
    async request() {
      throw new Error("An unspecified upload target must not be resolved.")
    },
    async finishTurn() {},
    async closeSession() {},
  })
  if (typeof tool.approvalRequirement !== "function")
    throw new Error("Missing browser approval.")
  const upload = {
    action: "upload",
    ref: "e1",
    paths: ["/workspace/files"],
    directory: true,
  }
  expect(
    await tool.approvalRequirement({ ...upload, tabId: target.tabId }, context),
  ).toMatchObject({
    kind: "approval",
    action: "command_execution",
    subject: expect.stringContaining("selected, ref e1"),
    reason: expect.stringMatching(/recursively.*\/workspace\/files/),
  })
  expect(await tool.execute(upload, context)).toMatchObject({
    ok: false,
    code: "invalid_arguments",
  })
})
