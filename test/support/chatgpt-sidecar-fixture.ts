import { Socket } from "node:net"
import { createTestNetworkGuard } from "./test-network-guard.ts"
import { join } from "node:path"
import { runYakitoriServerProcess } from "../../src/server/server-process.ts"
import { createChatGPTFixture } from "./chatgpt-fixture.ts"

const guard = createTestNetworkGuard(Socket.prototype.connect)
Socket.prototype.connect = guard.connect as Socket["connect"]
process.on("exit", () => {
  if (guard.takeBlockedHosts().length > 0) process.exitCode = 1
})

const root = process.env.YAKITORI_TEST_ROOT
if (!root) throw new Error("An isolated sidecar root is required.")
const protocol = createChatGPTFixture()
await runYakitoriServerProcess({
  host: "127.0.0.1",
  port: 0,
  application: {
    rootDir: join(root, "store"),
    workspace: root,
    userConfigPath: join(root, "config.toml"),
    provider: "faux",
    chatgpt: {
      fetchFn: protocol.fetchFn,
      async openAuthorization(url) {
        await protocol.openAuthorization(url)
        // Fixture-only IPC contains the non-sensitive bound listener address.
        process.send?.({
          type: "fixture-chatgpt-listener",
          redirectUri: protocol.authorization.searchParams.get("redirect_uri"),
        })
      },
    },
  },
  onListening(url) {
    console.log(`yakitori-listening ${url}`)
  },
})
