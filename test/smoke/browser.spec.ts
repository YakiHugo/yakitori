import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import {
  type ServerProcess,
  spawnServerProcess,
} from "../../src/desktop/server-process.ts"
import {
  createSmokeEnvironment,
  runBudgetedGoal,
  runFauxTurn,
  runProviderFlow,
} from "./fixtures.ts"

test("built GUI sends a turn and restores its transcript after reload", async ({
  page,
}, testInfo) => {
  const environment = await createSmokeEnvironment()
  const errors: string[] = []
  const logs: string[] = []
  let server: ServerProcess | undefined
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    server = await spawnServerProcess({
      command: process.execPath,
      args: [resolve("src/server/start.ts")],
      cwd: environment.root,
      env: { ...environment.env, YAKITORI_GUI_DIR: resolve("dist/gui") },
      onStdout: (line) => logs.push(line),
      onStderr: (line) => logs.push(line),
    })
    await page.goto(server.url)
    await runFauxTurn(page)
    await page.reload()
    await expect(
      page.getByRole("main").getByText("Check the CI smoke flow.", {
        exact: true,
      }),
    ).toBeVisible()
    await expect(
      page.getByRole("main").getByText("Hello from faux.", { exact: true }),
    ).toBeVisible()
    await runBudgetedGoal(page)
    await runProviderFlow(page, testInfo)
    expect(errors).toEqual([])
  } finally {
    try {
      await testInfo.attach("server.log", {
        body: logs.join("\n"),
        contentType: "text/plain",
      })
    } finally {
      // Failed assertions or diagnostics must not strand the owned sidecar.
      const timer = setTimeout(() => void server?.forceStop(), 5_000)
      try {
        await server?.stop()
      } finally {
        clearTimeout(timer)
        await environment.cleanup()
      }
    }
  }
})
