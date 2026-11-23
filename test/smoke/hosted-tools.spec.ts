import { once } from "node:events"
import { writeFile } from "node:fs/promises"
import { createServer, type ServerResponse } from "node:http"
import { join, resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { stringify } from "smol-toml"
import {
  type ServerProcess,
  spawnServerProcess,
} from "../../src/desktop/server-process.ts"
import { createSmokeEnvironment } from "./fixtures.ts"

const prompt = "Run a provider search fixture."
const query = "provider search example"
const answer = "The provider finished its search."
const source = "https://example.test/search-result"

function send(response: ServerResponse, frame: Record<string, unknown>) {
  response.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`)
}

function finish(response: ServerResponse, output: readonly unknown[]) {
  send(response, {
    type: "response.completed",
    response: {
      id: "resp_fixture",
      model: "hosted-fixture",
      status: "completed",
      incomplete_details: null,
      error: null,
      output,
    },
  })
  response.end()
}

function message(text: string) {
  return {
    type: "message",
    id: "fixture_answer",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  }
}

test("shows hosted search while running and restores it after reopening", async ({
  page,
}) => {
  const environment = await createSmokeEnvironment()
  let server: ServerProcess | undefined
  let running: ServerResponse | undefined
  const search = {
    type: "web_search_call",
    id: "fixture_search",
    status: "in_progress",
    action: { type: "search", query },
  }
  const endpoint = createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ data: [{ id: "hosted-fixture" }] }))
      return
    }
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end()
      return
    }
    request.setEncoding("utf8")
    let body = ""
    request.on("data", (text: string) => {
      body += text
    })
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" })
      if (!body.includes(prompt)) {
        finish(response, [message('{"title":"Hosted search fixture"}')])
        return
      }
      running = response
      send(response, {
        type: "response.output_item.added",
        output_index: 0,
        item: search,
      })
    })
  })
  try {
    endpoint.listen(0, "127.0.0.1")
    await once(endpoint, "listening")
    const address = endpoint.address()
    if (address === null || typeof address === "string")
      throw new Error("Provider fixture did not bind")
    await writeFile(
      join(environment.root, "home", "config.toml"),
      stringify({
        provider: "fixture",
        model: "hosted-fixture",
        model_providers: {
          fixture: {
            name: "Hosted fixture",
            api_backend: "responses",
            base_url: `http://127.0.0.1:${address.port}/v1`,
            authentication: "none",
            models: [{ id: "hosted-fixture" }],
          },
        },
      }),
    )
    const start = (port: string) =>
      spawnServerProcess({
        command: process.execPath,
        args: [resolve("src/server/start.ts")],
        cwd: environment.root,
        env: {
          ...environment.env,
          PORT: port,
          YAKITORI_PROVIDER: "fixture",
          YAKITORI_MODEL: "hosted-fixture",
          YAKITORI_GUI_DIR: resolve("dist/gui"),
        },
      })
    server = await start("0")
    await page.goto(server.url)
    await page.getByRole("button", { name: "New session", exact: true }).click()
    await page.getByRole("textbox", { name: "Message the Mate" }).fill(prompt)
    await page.getByRole("button", { name: "Send", exact: true }).click()
    const live = page.getByRole("region", { name: "Current response" })
    await expect(live.getByText(`Search web · ${query}`)).toBeVisible()
    await expect(live.getByText("running", { exact: true })).toBeVisible()
    if (running === undefined)
      throw new Error("Hosted provider stream is missing")
    const completedSearch = {
      ...search,
      status: "completed",
      action: { ...search.action, sources: [{ type: "url", url: source }] },
    }
    send(running, {
      type: "response.output_item.done",
      output_index: 0,
      item: completedSearch,
    })
    finish(running, [completedSearch, message(answer)])
    running = undefined

    const completed = page.getByRole("region", {
      name: "Response",
      exact: true,
    })
    const checkHistory = async () => {
      await expect(completed.getByText(answer, { exact: true })).toBeVisible()
      await completed.getByRole("button", { name: /^Worked for/ }).click()
      await completed.getByText(`Search web · ${query}`).click()
      await expect(completed.getByText(source, { exact: true })).toBeVisible()
      await expect(completed.getByText("Hosted", { exact: true })).toBeVisible()
    }
    await checkHistory()
    const port = new URL(server.url).port
    await server.stop()
    server = await start(port)
    await page.reload()
    await checkHistory()
  } finally {
    running?.end()
    await server?.stop()
    endpoint.closeAllConnections()
    await new Promise<void>((resolve) => endpoint.close(() => resolve()))
    await environment.cleanup()
  }
})
