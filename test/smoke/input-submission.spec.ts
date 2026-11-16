import { join, resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { spawnServerProcess } from "../../src/desktop/server-process.ts"
import { createSmokeEnvironment } from "./fixtures.ts"
import { runInputSubmissionFlow } from "./input-submission-flow.ts"

test("input confirmation releases the composer before RPC acknowledgement", async ({
  page,
}) => {
  const environment = await createSmokeEnvironment()
  const server = await spawnServerProcess({
    command: process.execPath,
    args: [resolve("src/server/start.ts")],
    cwd: environment.root,
    env: { ...environment.env, YAKITORI_GUI_DIR: resolve("dist/gui") },
  })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.goto(server.url)
    await runInputSubmissionFlow(
      page,
      join(environment.root, "workspace", "smoke.png"),
    )
    expect(errors).toEqual([])
  } finally {
    await server.stop()
    await environment.cleanup()
  }
})
