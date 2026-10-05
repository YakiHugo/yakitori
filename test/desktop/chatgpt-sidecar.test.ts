import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { spawnServerProcess } from "../../src/desktop/server-process.ts"
import { createChatGPTRpcClient } from "../support/chatgpt-rpc-client.ts"

it("desktop sidecar serves safe sign-in RPC and closes its pending OAuth listener on native shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-chatgpt-sidecar-"))
  const logs: string[] = []
  const server = await spawnServerProcess({
    command: process.execPath,
    args: [join(process.cwd(), "test/support/chatgpt-sidecar-fixture.ts")],
    cwd: root,
    env: { ...process.env, YAKITORI_TEST_ROOT: root },
    onStdout: (line) => logs.push(line),
    onStderr: (line) => logs.push(line),
  })
  const rpc = await createChatGPTRpcClient(server.url)
  try {
    const listener = new Promise<string>((resolve) =>
      server.child.on("message", (message) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "fixture-chatgpt-listener" &&
          "redirectUri" in message &&
          typeof message.redirectUri === "string"
        )
          resolve(message.redirectUri)
      }),
    )
    const state = await rpc.request("chatgpt/signIn", {
      label: "Desktop fixture",
    })
    expect(state.attempt?.state).toBe("waiting")
    const redirectUri = await listener
    expect((await fetch(redirectUri)).status).toBe(400)
    rpc.close()
    await server.stop()
    expect(server.child.exitCode).toBe(0)
    await expect(fetch(redirectUri)).rejects.toThrow()
    expect(logs.join("\n") + rpc.frames.join("\n")).not.toMatch(
      /api\/accounts\/authorize|id_token_hint|fixture-access|fixture-refresh/,
    )
  } finally {
    rpc.close()
    await server.stop()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
