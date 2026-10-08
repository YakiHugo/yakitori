import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { createMcpConnectionManager } from "../../src/runtime/mcp-connection-manager.ts"

for (const replacement of [false, true]) {
  it(`${replacement ? "replaces" : "removes"} a pending optional connection without leaving its process alive`, async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-mcp-pending-"))
    const script = join(root, "server.mjs")
    const pidFile = join(root, "pid")
    await writeFile(
      script,
      `
import {writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
writeFileSync(process.argv[2], String(process.pid));
createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line);
  if (m.id === undefined || process.argv[3] !== 'ready') return;
  const result = m.method === 'tools/list' ? {tools:[]} : {protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});
`,
    )
    const manager = createMcpConnectionManager({ maxRestartAttempts: 0 })
    const statuses: ReturnType<typeof manager.status>[] = []
    manager.subscribeStatus(() => statuses.push(manager.status()))
    try {
      await manager.update({
        demo: {
          command: process.execPath,
          args: [script, pidFile],
          startupTimeoutMs: 30_000,
        },
      })
      await expect
        .poll(async () => readFile(pidFile, "utf8").catch(() => ""))
        .not.toBe("")
      const pid = Number(await readFile(pidFile, "utf8"))
      await manager.update(
        replacement
          ? {
              demo: {
                command: process.execPath,
                args: [script, join(root, "new-pid"), "ready"],
                required: true,
              },
            }
          : {},
      )
      await expect
        .poll(
          () => {
            try {
              process.kill(pid, 0)
              return true
            } catch {
              return false
            }
          },
          { timeout: 1_000 },
        )
        .toBe(false)
      expect(statuses.at(-1)).toEqual(manager.status())
      expect(manager.status()).toEqual(
        replacement
          ? [{ name: "demo", state: "ready", toolCount: 0, required: true }]
          : [],
      )
    } finally {
      await manager.close()
      await rm(root, { recursive: true, force: true })
    }
  })
}
