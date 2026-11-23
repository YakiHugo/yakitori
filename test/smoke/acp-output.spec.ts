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
    await live.getByRole("button", { name: "1 tool call", exact: true }).click()
    await expect(
      live.getByRole("button", { name: /^Thought for / }),
    ).toBeVisible()
    await checkImage(history)
    await checkSources()
    const port = new URL(server.url).port
    await server.stop()
    server = await start(port)
    await page.reload()
    await checkImage(history)
    await checkSources()
    await history.getByRole("button", { name: /^Worked for/ }).click()
    await history
      .getByRole("button", { name: "1 tool call", exact: true })
      .click()
    await history.getByRole("button", { name: /^Thought for / }).click()
    await expect(history.getByText("Plan the ACP fixture image.")).toBeVisible()
  } finally {
    await server?.stop()
    await environment.cleanup()
  }
})

test("restores distinct ACP user messages and their media from session/load", async ({
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
        YAKITORI_ACP_ENGINES: JSON.stringify([
          {
            id: "history-acp",
            label: "History ACP",
            command: process.execPath,
            args: [resolve("test/fixtures/acp/agent.mjs"), "load-media"],
          },
        ]),
      },
    })
  let server: ServerProcess | undefined
  try {
    server = await start("0")
    await page.goto(server.url)
    await page.getByRole("combobox", { name: "New session engine" }).click()
    await page.getByRole("option", { name: "History ACP", exact: true }).click()
    const send = async (text: string) => {
      await page.getByRole("textbox", { name: "Message the Mate" }).fill(text)
      await page.getByRole("button", { name: "Send", exact: true }).click()
    }
    await send("structured")
    await expect(
      page.getByText("The ACP fixture is ready.", { exact: true }),
    ).toBeVisible()
    const port = new URL(server.url).port
    await server.stop()
    server = await start(port)
    await page.reload()
    await expect(
      page.getByText("The ACP fixture is ready.", { exact: true }),
    ).toBeVisible()
    await send("follow up")
    await expect(
      page.getByText("First historical message", { exact: true }),
    ).toBeVisible()
    await expect(
      page.getByText("Second historical message", { exact: true }),
    ).toBeVisible()
    await expect(
      page.getByText("Replayed reply", { exact: true }),
    ).toBeVisible()
    await page.getByRole("button", { name: "Activity", exact: true }).click()
    await expect(
      page.getByRole("list", { name: "Agent activity" }),
    ).toBeVisible()
    const image = page.getByRole("img", { name: "User image" })
    await expect(image).toBeVisible()
    await expect
      .poll(() =>
        image.evaluate((img) => (img as HTMLImageElement).naturalWidth),
      )
      .toBe(1)
    await expect(
      page.getByRole("link", { name: "history.txt" }),
    ).toHaveAttribute("href", "https://example.test/history.txt")
    await expect(
      page.getByText("Historical attachment contents", { exact: true }),
    ).toBeVisible()
  } finally {
    await server?.stop()
    await environment.cleanup()
  }
})
