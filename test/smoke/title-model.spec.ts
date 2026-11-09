import { once } from "node:events"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { parse } from "smol-toml"
import {
  type ServerProcess,
  spawnServerProcess,
} from "../../src/desktop/server-process.ts"
import { createAppRpcClient } from "../../src/gui/lib/rpc-client.ts"
import { createSmokeEnvironment } from "./fixtures.ts"

test("title model selection persists across reloads and resets without losing model visibility", async ({
  page,
}, testInfo) => {
  const environment = await createSmokeEnvironment()
  let server: ServerProcess | undefined
  let client: ReturnType<typeof createAppRpcClient> | undefined
  let catalogReads = 0
  const unexpectedRequests: string[] = []
  const endpoint = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      catalogReads++
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          data: [
            { id: "private-deployment" },
            { id: "gpt-5" },
            { id: "gpt-6.1-sol" },
          ],
        }),
      )
      return
    }
    unexpectedRequests.push(`${request.method} ${request.url}`)
    response.writeHead(404)
    response.end()
  })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    endpoint.listen(0, "127.0.0.1")
    await once(endpoint, "listening")
    const address = endpoint.address()
    if (!address || typeof address === "string")
      throw new Error("Missing model catalog endpoint")
    server = await spawnServerProcess({
      command: process.execPath,
      args: [resolve("src/server/start.ts")],
      cwd: environment.root,
      env: { ...environment.env, YAKITORI_GUI_DIR: resolve("dist/gui") },
    })
    client = createAppRpcClient({ apiBase: server.url })
    await client.request("provider/configuration/write", {
      id: "title-smoke",
      configuration: {
        name: "Title smoke",
        authentication: "none",
        wireApi: "openai_chat_completions",
        baseURL: `http://127.0.0.1:${address.port}/v1`,
        models: [],
      },
    })
    const configuration = await client.request("config/read", {})
    const user = configuration.layers.find((layer) => layer.source === "user")
    if (!user) throw new Error("Missing user configuration file")
    const readConfiguration = async () =>
      parse(await readFile(user.path, "utf8"))
    const openAccount = async () => {
      await page.getByRole("button", { name: "Settings", exact: true }).click()
      await page.getByRole("button", { name: "Providers", exact: true }).click()
      await page.getByRole("button", { name: /^Title smoke/ }).click()
    }
    await page.goto(server.url)
    await openAccount()
    const models = page.getByRole("region", { name: "Account models" })
    const titleActions = models.getByRole("button", {
      name: "Model actions for gpt-6.1-sol",
      exact: true,
    })
    const visibility = models.getByRole("switch", {
      name: "Enable gpt-5",
      exact: true,
    })
    await expect(models.getByRole("switch")).toHaveCount(3)
    expect(
      await models
        .getByRole("switch")
        .evaluateAll((items) =>
          items.map((item) => item.getAttribute("aria-label")),
        ),
    ).toEqual([
      "Enable gpt-6.1-sol",
      "Enable gpt-5",
      "Enable private-deployment",
    ])
    await expect(models.locator("details, summary")).toHaveCount(0)
    await expect(models.getByText("Title model", { exact: true })).toHaveCount(
      0,
    )
    await titleActions.focus()
    await page.keyboard.press("Enter")
    const titleChoice = page.getByRole("menuitemradio", {
      name: "Set as title model",
      exact: true,
    })
    await expect(titleChoice).toHaveAttribute("aria-checked", "false")
    await expect(titleChoice).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("menu")).toHaveCount(0)
    await expect(titleActions).toBeFocused()
    await expect
      .poll(readConfiguration)
      .not.toHaveProperty(["model_providers", "title-smoke", "title_model"])

    await titleActions.click()
    await titleChoice.click()
    await visibility.click()
    await expect.poll(readConfiguration).toMatchObject({
      model_providers: { "title-smoke": { title_model: "gpt-6.1-sol" } },
      models: { "title-smoke": { "gpt-5": { visible: false } } },
    })
    await expect(models.getByText("Title model", { exact: true })).toBeVisible()
    await page.reload()
    await openAccount()
    await expect(models.getByText("Title model", { exact: true })).toBeVisible()
    await expect(visibility).toHaveAttribute("aria-checked", "false")
    await titleActions.click()
    await expect(titleChoice).toHaveAttribute("aria-checked", "true")
    await page.screenshot({
      path: testInfo.outputPath("title-model-selected.png"),
      fullPage: true,
      animations: "disabled",
    })
    await page
      .getByRole("menuitem", { name: "Use automatic selection", exact: true })
      .click()
    await expect
      .poll(readConfiguration)
      .not.toHaveProperty(["model_providers", "title-smoke", "title_model"])
    await expect.poll(readConfiguration).toMatchObject({
      models: { "title-smoke": { "gpt-5": { visible: false } } },
    })
    await page.reload()
    await openAccount()
    await expect(models.getByText("Title model", { exact: true })).toHaveCount(
      0,
    )
    await expect(visibility).toHaveAttribute("aria-checked", "false")
    await visibility.click()
    await expect.poll(readConfiguration).toMatchObject({
      models: { "title-smoke": { "gpt-5": { visible: true } } },
    })
    await expect(visibility).toHaveAttribute("aria-checked", "true")
    await expect(page.getByRole("alert")).toHaveCount(0)
    await page.screenshot({
      path: testInfo.outputPath("title-model-automatic.png"),
      fullPage: true,
      animations: "disabled",
    })
    expect(catalogReads).toBeGreaterThan(0)
    expect(unexpectedRequests).toEqual([])
    expect(errors).toEqual([])
  } finally {
    client?.close()
    await server?.stop()
    endpoint.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      endpoint.close((error) => (error ? reject(error) : resolve())),
    )
    await environment.cleanup()
  }
})
