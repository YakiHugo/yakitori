import { once } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stringify } from "smol-toml"
import { afterEach, expect, it, onTestFinished, vi } from "vitest"
import type {
  RolloutItem,
  ResponseItemEnvelope,
} from "../../../src/core/rollout.ts"
import { PersistContext } from "../../../src/core/thread-store.ts"
import { createAppRpcClient } from "../../../src/gui/lib/rpc-client.ts"
import { SessionConfiguration } from "../../../src/runtime/session-configuration.ts"
import { createYakitoriApplication } from "../../../src/server/application.ts"

afterEach(() => vi.unstubAllEnvs())

const logical = { provider: "shared-vendor", model: "coder" }
const createdAt = "2026-10-25T00:00:00.000Z"

it("previews active compacted history without retaining old transcript image requirements", async () => {
  const fixture = await createFixture()
  const { image } = fixture
  const oldImage: ResponseItemEnvelope = {
    id: "old_user_image",
    turnId: "old_turn",
    createdAt,
    item: { role: "user", content: [image] },
  }
  const sessionId = await fixture.storeSession("compacted", "first", [
    { type: "response_item", item: oldImage },
    {
      type: "compacted",
      turnId: "compaction",
      summary: "The earlier image has been summarized.",
      replacement: [
        {
          id: "summary",
          turnId: "compaction",
          createdAt,
          item: {
            role: "user",
            content: [{ type: "text", text: "Earlier image summary." }],
          },
        },
      ],
    },
  ])
  const stored = await fixture.application.threadStore.readThread(sessionId)
  expect(stored?.rollout).toContainEqual(
    expect.objectContaining({
      item: { type: "response_item", item: oldImage },
    }),
  )
  const preview = await fixture.client.request("model/preview", {
    selection: logical,
    sessionId,
  })
  expect(preview).toMatchObject({
    available: true,
    target: { provider: "first", model: "shared" },
    inputModalities: ["text"],
  })
})

it("rejects text-only members when a tool image remains in active stored history", async () => {
  const fixture = await createFixture()
  const { image } = fixture
  const sessionId = await fixture.storeSession("tool_image", "first", [
    {
      type: "response_item",
      item: {
        id: "assistant_tool_call",
        turnId: "tool_turn",
        createdAt,
        item: {
          role: "assistant",
          response: {
            callId: "call_image",
            attemptId: "attempt_image",
            attempt: 1,
            provider: "first",
            model: "shared",
          },
          content: [
            {
              type: "tool_call",
              id: "read_image",
              name: "read_file",
              input: { path: "image.png" },
            },
          ],
        },
      },
    },
    {
      type: "response_item",
      item: {
        id: "tool_image",
        turnId: "tool_turn",
        createdAt,
        item: { role: "tool", toolCallId: "read_image", content: [image] },
      },
    },
  ])
  const preview = await fixture.client.request("model/preview", {
    selection: logical,
    sessionId,
  })
  expect(preview.available).toBe(false)
  expect(preview.rejections).toEqual([
    expect.objectContaining({
      accountId: "first",
      code: "unsupported_modality",
    }),
    expect.objectContaining({
      accountId: "second",
      code: "unsupported_modality",
    }),
  ])
  expect(preview.target).toBeUndefined()
})

it("previews an unset effort using the session's preferred account default", async () => {
  const fixture = await createFixture()
  const sessionId = await fixture.storeSession("preferred", "second", [])
  const fresh = await fixture.client.request("model/preview", {
    selection: logical,
  })
  const continuing = await fixture.client.request("model/preview", {
    selection: logical,
    sessionId,
  })
  expect(fresh).toMatchObject({
    available: true,
    target: { provider: "first", model: "shared" },
    defaultEffort: "low",
  })
  expect(continuing).toMatchObject({
    available: true,
    target: { provider: "second", model: "shared" },
    defaultEffort: "high",
  })
})

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "yakitori-model-preview-"))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, "workspace")
  await mkdir(workspace)
  for (const key of [
    "YAKITORI_PROVIDER",
    "YAKITORI_MODEL",
    "YAKITORI_FAUX_SCENARIO",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "XAI_API_KEY",
    "KIMI_API_KEY",
    "MOONSHOT_API_KEY",
    "YAKITORI_ACP_ENGINES",
  ])
    vi.stubEnv(key, undefined)
  vi.stubEnv("CODEX_HOME", join(root, "missing-codex-home"))
  vi.stubEnv("GROK_CREDENTIALS", join(root, "missing-grok-auth"))
  const endpoint = createServer((request, response) => {
    if (request.method !== "GET")
      throw new Error("Preview must not sample a model.")
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ data: [{ id: "shared" }] }))
  })
  endpoint.listen(0, "127.0.0.1")
  await once(endpoint, "listening")
  onTestFinished(async () => {
    endpoint.closeAllConnections()
    await new Promise<void>((resolve) => endpoint.close(() => resolve()))
  })
  const address = endpoint.address()
  if (!address || typeof address === "string")
    throw new Error("Missing model catalog endpoint")
  const userConfigPath = join(root, "config.toml")
  await writeFile(
    userConfigPath,
    stringify({
      model_providers: Object.fromEntries(
        ["first", "second"].map((name) => [
          name,
          {
            name,
            authentication: "none",
            base_url: `http://127.0.0.1:${address.port}/${name}/v1`,
            api_backend: "chat_completions",
            models: [
              {
                id: "shared",
                identity: { namespace: "shared-vendor", model: "coder" },
                inputModalities: ["text"],
                efforts: ["low", "high"],
                defaultEffort: name === "first" ? "low" : "high",
              },
            ],
          },
        ]),
      ),
    }),
  )
  const application = await createYakitoriApplication({
    rootDir: join(root, "app"),
    workspace,
    userConfigPath,
    provider: "faux",
    model: "scripted",
    mcp: false,
    skills: false,
  })
  onTestFinished(() => application.close())
  await application.threadStore.createThread({
    id: "preview_media",
    conversationId: "conversation_media",
    createdAt,
    updatedAt: createdAt,
    workingDirectory: workspace,
  })
  await application.threadStore.persistThread(
    "preview_media",
    PersistContext.TurnStart,
  )
  const attachments = await application.rolloutAssets.importAttachmentBytes(
    "preview_media",
    "preview_owner",
    [
      {
        name: "preview.png",
        data: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWP4z8BAEmIY1cAwGkr/h2vSAACQ+f8BxdOlvwAAAABJRU5ErkJggg==",
          "base64",
        ),
      },
    ],
  )
  await application.threadStore.shutdownThread("preview_media")
  const attachment = attachments[0]
  if (attachment?.mediaType !== "image/png")
    throw new Error("Missing stored image fixture")
  const image = {
    type: "image" as const,
    mediaType: "image/png" as const,
    file: attachment.file,
    sizeBytes: attachment.sizeBytes,
  }
  const server = application.createHttpServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const serverAddress = server.address()
  if (!serverAddress || typeof serverAddress === "string")
    throw new Error("Missing application endpoint")
  const client = createAppRpcClient({
    apiBase: `http://127.0.0.1:${serverAddress.port}`,
  })
  onTestFinished(() => client.close())
  return {
    application,
    client,
    image,
    async storeSession(
      id: string,
      account: string,
      items: readonly RolloutItem[],
    ) {
      const selection = { provider: account, model: "shared" }
      const configuration = SessionConfiguration.create({
        selection,
        workspaceRoot: workspace,
        enabledTools: [],
        approvalPolicy: "always_approve",
        promptCacheKey: id,
      }).snapshot
      await application.threadStore.createThread({
        id,
        conversationId: `conversation_${id}`,
        createdAt,
        updatedAt: createdAt,
        workingDirectory: workspace,
      })
      await application.threadStore.persistThread(id, PersistContext.TurnStart)
      await application.threadStore.appendItems(id, [
        {
          type: "turn_context",
          context: { turnId: "stored_turn", selection, configuration },
        },
        ...items,
      ])
      await application.threadStore.persistThread(id, PersistContext.Standard)
      await application.threadStore.shutdownThread(id)
      return id
    },
  }
}
