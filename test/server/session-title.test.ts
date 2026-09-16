import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import {
  createSessionTitleGenerator,
  KIMI_TITLE_MODEL,
  normalizeSessionTitle,
  resolveTitleTarget,
} from "../../src/server/session-title.ts"
import { createThreadServerHandlers } from "../../src/server/handlers.ts"
import { MemoryThreadStore } from "../core/memory-thread-store.ts"
import { createFauxProvider } from "../support/faux-provider.ts"
import { waitForValue } from "../support/wait-for-value.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { createTurnProcessor } from "../../src/runtime/turn-processor.ts"
import type { ModelRequest, ModelStreamEvent } from "../../src/runtime/model.ts"

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

function titleStream(title: string | (() => string)) {
  return vi.fn((_request: ModelRequest): AsyncIterable<ModelStreamEvent> => {
    const body = typeof title === "function" ? title() : title
    const events: ModelStreamEvent[] = [
      { type: "snapshot", text: body },
      {
        type: "response",
        response: {
          stopReason: "end_turn",
          content: [{ type: "text", text: body }],
        },
      },
    ]
    return (async function* () {
      yield* events
    })()
  })
}

describe("normalizeSessionTitle", () => {
  it("trims punctuation, quotes, and whitespace", () => {
    expect(normalizeSessionTitle('  "Fix login button."  ')).toBe(
      "Fix login button",
    )
    expect(normalizeSessionTitle("重构登录接口！")).toBe("重构登录接口")
  })

  it("truncates to the sidebar display width on a character boundary", () => {
    expect(normalizeSessionTitle("a".repeat(100))).toHaveLength(36)
    // CJK measures two half-width columns: 18 characters fill the budget.
    expect(normalizeSessionTitle("修".repeat(100))).toHaveLength(18)
    const mixed = normalizeSessionTitle("ab修".repeat(20))
    expect(mixed).toBeDefined()
    expect(
      [...(mixed as string)].reduce(
        (width, char) => width + (/[一-鿿]/.test(char) ? 2 : 1),
        0,
      ),
    ).toBeLessThanOrEqual(36)
  })

  it("backs off to a word boundary instead of ending a latin word mid-way", () => {
    const title = normalizeSessionTitle(
      "Refactor authentication middleware for session tokens",
    )
    expect(title).toBeDefined()
    expect((title as string).endsWith("middleware")).toBe(true)
    expect(/^[A-Za-z0-9 ]+$/.test(title as string)).toBe(true)
  })

  it("rejects non-strings and empty results", () => {
    expect(normalizeSessionTitle(undefined)).toBeUndefined()
    expect(normalizeSessionTitle("")).toBeUndefined()
    expect(normalizeSessionTitle("...")).toBeUndefined()
  })
})

describe("resolveTitleTarget", () => {
  it("prefers Kimi's cheapest model whenever that provider is registered", () => {
    expect(
      resolveTitleTarget(["kimi", "anthropic"], {
        provider: "anthropic",
        model: "claude-opus-4-6",
      }),
    ).toEqual({
      provider: "kimi",
      model: KIMI_TITLE_MODEL,
      instructionProfileId: KIMI_TITLE_MODEL,
      // Thinking stays off: reasoning would consume the small output budget.
      effort: "off",
    })
  })

  it("falls back to the session model selection", () => {
    expect(resolveTitleTarget(["anthropic"], undefined)).toBeUndefined()
    expect(
      resolveTitleTarget(["anthropic"], {
        provider: "anthropic",
        model: "claude-haiku-4-5",
      }),
    ).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      instructionProfileId: "claude-haiku-4-5",
    })
  })

  it("never targets the faux provider", () => {
    expect(
      resolveTitleTarget(["faux"], { provider: "faux", model: "scripted" }),
    ).toBeUndefined()
    expect(resolveTitleTarget(undefined, undefined)).toBeUndefined()
  })
})

async function sidebarTitle(
  store: MemoryThreadStore,
  sessionId: string,
): Promise<string | undefined> {
  const presentation = (await store.sessionPresentation(sessionId)) as {
    title?: string
  }
  return presentation.title
}

describe("session title generator", () => {
  let store: MemoryThreadStore
  let sessionId: string

  beforeEach(async () => {
    store = new MemoryThreadStore()
    const created = await store.createThread({
      id: "thread_title_test",
      conversationId: "thread_title_test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    sessionId = created.metadata.id
  })

  it("names an untitled session from its first input and notifies", async () => {
    const stream = titleStream('{"title":"Fix login button"}')
    const notifySidebarChanged = vi.fn()
    const generator = createSessionTitleGenerator({
      stream,
      store,
      availableProviders: ["kimi"],
      notifySidebarChanged,
    })
    await generator.generate({
      sessionId,
      text: "Fix the login button on mobile",
    })
    expect(await sidebarTitle(store, sessionId)).toBe("Fix login button")
    expect(notifySidebarChanged).toHaveBeenCalledOnce()
    const request = stream.mock.calls[0]?.[0]
    expect(request?.target).toMatchObject({ provider: "kimi" })
    expect(JSON.stringify(request?.system)).not.toContain(
      "Fix the login button on mobile",
    )
    expect(JSON.stringify(request?.messages)).toContain(
      "Fix the login button on mobile",
    )
  })

  it("keeps a metadata title and never generates twice", async () => {
    const stream = titleStream('{"title":"Second title"}')
    const generator = createSessionTitleGenerator({
      stream,
      store,
      availableProviders: ["kimi"],
    })
    await generator.generate({ sessionId, text: "first request" })
    expect(stream).toHaveBeenCalledOnce()
    await generator.generate({ sessionId, text: "second request" })
    expect(stream).toHaveBeenCalledOnce()
    expect(await sidebarTitle(store, sessionId)).toBe("Second title")
  })

  it("never overwrites a title the user set while generation was in flight", async () => {
    const stream = titleStream(() => {
      void store.updateSessionSidebar({
        type: "session",
        sessionId,
        title: "User chosen name",
      })
      return '{"title":"Generated title"}'
    })
    const generator = createSessionTitleGenerator({
      stream,
      store,
      availableProviders: ["kimi"],
    })
    await generator.generate({ sessionId, text: "some request" })
    expect(await sidebarTitle(store, sessionId)).toBe("User chosen name")
  })

  it("skips silently when the model call fails or the text is empty", async () => {
    const failing = vi.fn(() => {
      throw new Error("boom")
    }) as unknown as import("../../src/runtime/model.ts").StreamFn
    const generator = createSessionTitleGenerator({
      stream: failing,
      store,
      availableProviders: ["kimi"],
    })
    await generator.generate({ sessionId, text: "request" })
    expect(await sidebarTitle(store, sessionId)).toBeUndefined()

    const stream = titleStream('{"title":"Unused"}')
    const empty = createSessionTitleGenerator({
      stream,
      store,
      availableProviders: ["kimi"],
    })
    await empty.generate({ sessionId, text: "   " })
    expect(stream).not.toHaveBeenCalled()
  })
})

describe("admitInput title trigger", () => {
  it("names only the first user input of an untitled session", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-title-trigger-"))
    const store = new MemoryThreadStore()
    const provider = createFauxProvider([
      { content: [{ type: "text", text: "done" }] },
      { content: [{ type: "text", text: "done" }] },
    ])
    const manager = new ThreadManager({
      store,
      createTurnProcessor: () =>
        createTurnProcessor({
          stream: provider.stream,
          toolRegistry: createToolRegistry([]),
          loadProjectInstructions: async () => undefined,
        }),
    })
    const generated: string[] = []
    const handlers = createThreadServerHandlers({
      manager,
      store,
      sessionTitle: {
        async generate(input) {
          generated.push(input.text)
          await store.updateSessionSidebar({
            type: "session",
            sessionId: input.sessionId,
            title: "Named once",
          })
        },
      },
    })
    cleanups.push(async () => {
      await manager.shutdown()
      await handlers.close()
      await rm(workspace, { recursive: true, force: true })
    })
    const created = await handlers.createSession({
      workingDirectory: workspace,
      mateId: "mate_test",
      mateRevisionId: "mate_revision_test",
    })
    if (!created.ok) throw new Error(created.body.error.message)
    const sessionId = created.body.session.id
    for (const text of ["first request", "second request"]) {
      const admitted = await handlers.admitInput({
        sessionId,
        requestId: `request_${text.split(" ")[0]}`,
        content: { kind: "text", text },
      })
      if (!admitted.ok) throw new Error(admitted.body.error.message)
      if (text === "first request") {
        await waitForValue(() =>
          manager.getThread(sessionId)?.status === "idle" ? true : undefined,
        )
      }
    }
    // Fire-and-forget generation lands without blocking admission.
    await vi.waitFor(() => {
      expect(generated).toEqual(["first request"])
    })
    expect(await sidebarTitle(store, sessionId)).toBe("Named once")
  })
})
