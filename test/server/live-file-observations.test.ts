import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createFauxProvider } from "../../src/runtime/faux-provider.ts"
import { ModelStopReason } from "../../src/runtime/model.ts"
import {
  createYakitoriApplication,
  type YakitoriApplication,
} from "../../src/server/application.ts"
import type { ApiHandlerResult } from "../../src/server/protocol.ts"

describe("live file observations", () => {
  it("restores a durable read after application restart before editing", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "yakitori-observation-"))
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-observation-work-"))
    const path = join(workspace, "value.txt")
    await writeFile(path, "value = 1\n")
    const options = {
      rootDir,
      workspace,
      userConfigPath: join(rootDir, "config.toml"),
    }
    try {
      const firstProvider = createFauxProvider([
        {
          stopReason: ModelStopReason.ToolUse,
          content: [
            {
              type: "tool_call",
              id: "tool_persisted_read",
              name: "read_file",
              input: { path: "value.txt" },
            },
          ],
        },
        { content: [{ type: "text", text: "read" }] },
      ])
      const first = await createYakitoriApplication({
        ...options,
        stream: firstProvider.stream,
      })
      const created = await first.handlers.createSession()
      expectOk(created)
      const sessionId = created.body.session.id
      expectOk(
        await first.handlers.admitInput({
          sessionId,
          requestId: "request_read_before_restart",
          content: { kind: "text", text: "read the file" },
        }),
      )
      await waitForThreadIdle(first, sessionId)
      await first.close()

      const secondProvider = createFauxProvider([
        {
          stopReason: ModelStopReason.ToolUse,
          content: [
            {
              type: "tool_call",
              id: "tool_edit_after_restart",
              name: "edit_file",
              input: {
                path: "value.txt",
                oldString: "value = 1",
                newString: "value = 2",
              },
            },
          ],
        },
        {
          assertRequest(request) {
            expect(request.messages).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  role: "tool",
                  toolCallId: "tool_edit_after_restart",
                  isError: undefined,
                }),
              ]),
            )
          },
          content: [{ type: "text", text: "edited" }],
        },
      ])
      const second = await createYakitoriApplication({
        ...options,
        stream: secondProvider.stream,
      })
      try {
        expectOk(
          await second.handlers.admitInput({
            sessionId,
            requestId: "request_edit_after_restart",
            content: { kind: "text", text: "edit the file" },
          }),
        )
        await waitForThreadIdle(second, sessionId)
        expect(await readFile(path, "utf8")).toBe("value = 2\n")
      } finally {
        await second.close()
      }
    } finally {
      await rm(rootDir, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
    }
  })
})

async function waitForThreadIdle(
  application: YakitoriApplication,
  threadId: string,
): Promise<void> {
  const thread = application.threadManager.getThread(threadId)
  if (thread === undefined || thread.status === "idle") return
  await new Promise<void>((resolve) => {
    const unsubscribe = thread.subscribeStatus((status) => {
      if (status !== "idle") return
      unsubscribe()
      resolve()
    })
  })
}

function expectOk<T>(
  result: ApiHandlerResult<T>,
): asserts result is Extract<ApiHandlerResult<T>, { readonly ok: true }> {
  if (!result.ok) {
    throw new Error(
      `Expected success: ${result.body.error.code}: ${result.body.error.message}`,
    )
  }
}
