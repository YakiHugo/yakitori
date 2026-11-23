import { resolve } from "node:path"
import { expect, type Locator, test } from "@playwright/test"
import {
  type ServerProcess,
  spawnServerProcess,
} from "../../src/desktop/server-process.ts"
import { createSmokeEnvironment } from "./fixtures.ts"

test("shows ACP images and resources live and after reopening", async ({
  page,
}) => {
  const environment = await createSmokeEnvironment()
  const start = (port: string) =>
    spawnServerProcess({
      command: process.execPath,
      args: [resolve("src/server/start.ts")],
      cwd: environment.root,
      env: {
        ...environment.env,
        PORT: port,
        YAKITORI_GUI_DIR: resolve("dist/gui"),
      },
    })
  const live = page.getByRole("region", {
    name: "Current response",
    exact: true,
  })
  const history = page.getByRole("region", { name: "Response", exact: true })
  const checkImage = async (response: Locator) => {
    const image = response.getByRole("img", { name: "Engine image" })
    await expect(image).toBeVisible()
    await expect
      .poll(() =>
        image.evaluate((node) => (node as HTMLImageElement).naturalWidth),
      )
      .toBe(1)
    await expect(
      response.getByRole("img", { name: "Tool image" }),
    ).toBeVisible()
  }
  const checkSources = async () => {
    await expect(history.getByText("Embedded engine notes")).toBeVisible()
    const sources = history.getByRole("region", { name: "Sources" })
    await expect(
      sources.getByRole("link", { name: "Engine reference" }),
    ).toHaveAttribute("href", "https://example.test/engine/reference")
    await expect(sources.getByText("engine-notes.txt")).toBeVisible()
    await expect(sources.getByRole("link")).toHaveCount(1)
  }
  let server: ServerProcess | undefined
  try {
    server = await start("0")
    await page.goto(server.url)
    await page.getByRole("combobox", { name: "New session engine" }).click()
    await page.getByRole("option", { name: "Smoke ACP", exact: true }).click()
    await page
      .getByRole("textbox", { name: "Message the Mate" })
      .fill("output-media")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await checkImage(live)
    await checkImage(history)
    await checkSources()
    const port = new URL(server.url).port
    await server.stop()
    server = await start(port)
    await page.reload()
    await checkImage(history)
    await checkSources()
  } finally {
    await server?.stop()
    await environment.cleanup()
  }
})
