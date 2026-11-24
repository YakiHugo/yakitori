import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  type Browser,
  type ElectronApplication,
  expect,
  test,
} from "@playwright/test"
import {
  type ServerProcess,
  spawnServerProcess,
} from "../../src/desktop/server-process.ts"
import {
  type AppRpcClient,
  createAppRpcClient,
} from "../../src/gui/lib/rpc-client.ts"
import { createSmokeEnvironment } from "./fixtures.ts"

test("Computer panel follows connection changes from another client", async ({
  playwright,
}, testInfo) => {
  test.skip(process.platform !== "darwin", "Computer use requires macOS.")
  const environment = await createSmokeEnvironment()
  let server: ServerProcess | undefined
  let application: ElectronApplication | undefined
  let browser: Browser | undefined
  let client: AppRpcClient | undefined
  try {
    const helper = join(environment.root, "computer.cjs")
    await writeFile(
      helper,
      `#!${process.execPath}
const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line); if (request.id === undefined) return;
  const result = request.method === 'initialize'
    ? {protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'computer-smoke',version:'1'}}
    : request.method === 'tools/list'
      ? {tools:['observe','input','app','internal'].map(name=>({name,annotations:{readOnlyHint:name==='observe'},inputSchema:{type:'object'}}))}
      : request.params.name === 'internal'
        ? {content:[],structuredContent:{accessibility:true,screenRecording:true}}
        : {content:[],structuredContent:{apps:[],windows:[],displays:[]}};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:request.id, result})+'\\n');
});`,
      { mode: 0o700 },
    )
    const env = {
      ...environment.env,
      YAKITORI_COMPUTER_EXECUTABLE: helper,
      YAKITORI_GUI_DIR: resolve("dist/gui"),
    }
    if (testInfo.project.name === "desktop") {
      application = await playwright._electron.launch({
        args: [
          resolve("."),
          `--user-data-dir=${join(environment.root, "electron-user-data")}`,
        ],
        cwd: environment.root,
        env,
      })
    } else {
      browser = await playwright.chromium.launch()
      server = await spawnServerProcess({
        command: process.execPath,
        args: [resolve("src/server/start.ts")],
        cwd: environment.root,
        env,
      })
    }
    const page = application
      ? await application.firstWindow()
      : await browser?.newPage()
    if (!page) throw new Error("The Computer panel renderer did not start.")
    if (server) await page.goto(server.url)
    else await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/?$/)
    await page
      .getByRole("button", { name: "Show workspace", exact: true })
      .click()
    await page.getByRole("button", { name: "Add workspace tab" }).click()
    await page.getByRole("menuitem", { name: "Computer", exact: true }).click()
    await expect(
      page.getByRole("button", { name: "Connect computer" }),
    ).toBeEnabled()
    client = createAppRpcClient({ apiBase: new URL(page.url()).origin })
    const status = await client.request("computer/connect", {})
    expect(status.tools).toEqual(["observe", "input", "app"])
    await expect(page.getByText("Ready for your next message")).toBeVisible()
    await client.request("computer/disconnect", {})
    await expect(
      page.getByRole("button", { name: "Connect computer" }),
    ).toBeEnabled()
  } finally {
    client?.close()
    await Promise.allSettled([
      application?.close(),
      browser?.close(),
      server?.stop(),
    ])
    await environment.cleanup()
  }
})
