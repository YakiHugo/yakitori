import { once } from "node:events"
import { createServer, type ServerResponse } from "node:http"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import {
  type ServerProcess,
  spawnServerProcess,
} from "../../src/desktop/server-process.ts"
import { createAppRpcClient } from "../../src/gui/lib/rpc-client.ts"
import { createSmokeEnvironment } from "./fixtures.ts"

const prompt = "Show the grounded answer and its sources."
const introduction = "前😀 **Gemini** "
const conclusion = "grounded answer"
const answer = introduction + conclusion
const sourceURL = "https://example.org/reference"
const sourceTitle = "Trusted reference"
const sourceQuote = "An excerpt from the source document."

for (const wireApi of [
  "gemini_generate_content",
  "gemini_interactions",
] as const) {
  test(`Gemini citation markers appear on completion and after server restart (${wireApi})`, async ({
    page,
  }) => {
    const environment = await createSmokeEnvironment()
    const interactions = wireApi === "gemini_interactions"
    const modelStream = interactions ? interactionStream : generateStream
    const { start, finish } = modelStream(answer)
    const titleReply = modelStream(JSON.stringify({ title: "Citation test" }))
    let pending: ServerResponse | undefined
    const endpoint = createServer(async (request, response) => {
      let body = ""
      request.setEncoding("utf8")
      for await (const chunk of request) body += chunk
      const url = request.url ?? ""
      if (request.method === "GET" && url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            models: [
              {
                name: "models/fixture",
                supportedGenerationMethods: ["generateContent"],
              },
            ],
          }),
        )
        return
      }
      if (
        request.method !== "POST" ||
        !(interactions
          ? url === "/v1/interactions"
          : url.startsWith("/v1/models/fixture:streamGenerateContent?"))
      ) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { "content-type": "text/event-stream" })
      const sent = JSON.parse(body) as { tools?: readonly unknown[] }
      if (!sent.tools?.length) {
        response.end(titleReply.start + titleReply.finish)
        return
      }
      response.write(start)
      if (pending === undefined && body.includes(prompt)) pending = response
      else response.end(finish)
    })
    const startServer = (port: string) =>
      spawnServerProcess({
        command: process.execPath,
        args: [resolve("src/server/start.ts")],
        cwd: environment.root,
        env: {
          ...environment.env,
          PORT: port,
          YAKITORI_GUI_DIR:
            environment.env.YAKITORI_GUI_DIR ?? resolve("dist/gui"),
        },
      })
    let server: ServerProcess | undefined
    try {
      endpoint.listen(0, "127.0.0.1")
      await once(endpoint, "listening")
      const address = endpoint.address()
      if (!address || typeof address === "string")
        throw new Error("Missing Gemini endpoint.")
      server = await startServer("0")
      const client = createAppRpcClient({ apiBase: new URL(server.url).origin })
      try {
        await client.request("provider/configuration/write", {
          id: "gemini-citations",
          configuration: {
            name: "Gemini Citations",
            authentication: "none",
            wireApi,
            baseURL: `http://127.0.0.1:${address.port}/v1`,
            models: [
              {
                id: "fixture",
                identity: { namespace: "gemini-citations", model: "fixture" },
              },
            ],
          },
        })
        await client.request("userPreference/write", {
          provider: "gemini-citations",
          model: "fixture",
        })
      } finally {
        client.close()
      }
      await page.goto(server.url)
      await page
        .getByRole("button", { name: "New session", exact: true })
        .click()
      await page.getByRole("textbox", { name: "Message the Mate" }).fill(prompt)
      await page.getByRole("button", { name: "Send", exact: true }).click()
      const main = page.getByRole("main")
      const sources = main.getByRole("region", { name: "Sources", exact: true })
      const link = sources.getByRole("link", { name: sourceTitle, exact: true })
      const marker = page.getByRole("link", {
        name: `Citation 1, ${sourceTitle}`,
      })
      const checkSources = async () => {
        await expect(link).toHaveAttribute("href", sourceURL)
        await expect(marker).toHaveAttribute("href", sourceURL)
        await expect(main.locator("p").filter({ has: marker })).toHaveText(
          interactions
            ? "前😀 Gemini grounded[1] answer"
            : "前😀 Gemini[1] grounded answer",
        )
        await marker.hover()
        const preview = page.locator('[data-slot="tooltip-content"]')
        await expect(preview).toBeVisible()
        await expect(preview).toContainText(sourceTitle)
        if (!interactions) await expect(preview).toContainText(sourceQuote)
        await page.mouse.move(0, 0)
        if (interactions) {
          const file = sources
            .getByRole("listitem")
            .filter({ hasText: "report.pdf" })
          await expect(file).toHaveText("report.pdf · from page 12")
          await expect(file.getByRole("link")).toHaveCount(0)
          await expect(
            main.getByRole("button", { name: "Citation 2, report.pdf" }),
          ).toHaveCount(0)
        }
      }
      await expect(main.getByText("Gemini", { exact: true })).toBeVisible()
      await expect(
        main.locator(".markdown p").filter({ hasText: conclusion }),
      ).toBeVisible()
      await expect(sources).toHaveCount(0)
      await expect(marker).toHaveCount(0)
      if (pending === undefined) throw new Error("Missing live Gemini stream.")
      pending.end(finish)
      await checkSources()
      await expect(
        page.getByRole("button", { name: "Interrupt", exact: true }),
      ).toHaveCount(0)
      const sessionURL = page.url()
      await server.stop()
      server = await startServer(new URL(sessionURL).port)
      await page.goto(sessionURL)
      await checkSources()
    } finally {
      pending?.destroy()
      await server?.stop()
      endpoint.closeAllConnections()
      await new Promise<void>((done) => endpoint.close(() => done()))
      await environment.cleanup()
    }
  })
}

function generateStream(text: string) {
  return {
    start: sse({
      candidates: [{ content: { role: "model", parts: [{ text }] } }],
    }),
    finish: sse({
      candidates: [
        {
          finishReason: "STOP",
          groundingMetadata: {
            groundingChunks: [
              {
                retrievedContext: {
                  uri: sourceURL,
                  title: sourceTitle,
                  text: sourceQuote,
                },
              },
            ],
            groundingSupports: [
              {
                segment: { startIndex: 10, endIndex: 16, text: "Gemini" },
                groundingChunkIndices: [0],
              },
            ],
          },
        },
      ],
    }),
  }
}

function interactionStream(text: string) {
  const id = "citation-interaction"
  const completeAnswer = text === answer
  const index = completeAnswer ? 1 : 0
  return {
    start:
      sse(
        {
          event_type: "interaction.created",
          interaction: { id, status: "in_progress" },
        },
        { event_type: "step.start", index: 0, step: { type: "model_output" } },
        {
          event_type: "step.delta",
          index: 0,
          delta: { type: "text", text: completeAnswer ? introduction : text },
        },
      ) +
      (completeAnswer
        ? sse(
            { event_type: "step.stop", index: 0 },
            { event_type: "step.start", index, step: { type: "model_output" } },
            {
              event_type: "step.delta",
              index,
              delta: { type: "text", text: conclusion },
            },
          )
        : ""),
    finish: sse(
      {
        event_type: "step.delta",
        index,
        delta: {
          type: "text_annotation_delta",
          annotations: [
            {
              type: "url_citation",
              url: sourceURL,
              title: sourceTitle,
              start_index: 0,
              end_index: 8,
            },
            {
              type: "file_citation",
              document_uri: "files/report",
              file_name: "report.pdf",
              page_number: 12,
            },
          ],
        },
      },
      { event_type: "step.stop", index },
      {
        event_type: "interaction.completed",
        interaction: { id, status: "completed" },
      },
    ),
  }
}

function sse(...events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
}
