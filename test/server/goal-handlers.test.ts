import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ThreadGoal } from "../../src/core/goal.ts"
import { SqliteGoalStore } from "../../src/core/sqlite-goal-store.ts"
import { PersistContext } from "../../src/core/thread-store.ts"
import type {
  ModelRequest,
  ModelResponse,
  StreamFn,
} from "../../src/runtime/model.ts"
import { SessionConfiguration } from "../../src/runtime/session-configuration.ts"
import {
  createYakitoriApplication,
  type YakitoriApplication,
} from "../../src/server/application.ts"
import type { ApiHandlerResult } from "../../src/server/protocol.ts"
import { deferred } from "./rpc/testkit.ts"

const roots: string[] = []
const applications = new Set<YakitoriApplication>()

beforeEach(() => {
  for (const name of [
    "YAKITORI_PROVIDER",
    "YAKITORI_MODEL",
    "YAKITORI_FAUX_SCENARIO",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "XAI_API_KEY",
    "KIMI_API_KEY",
  ]) {
    vi.stubEnv(name, undefined)
  }
  vi.stubEnv("CODEX_HOME", join(tmpdir(), "yakitori-goal-missing-codex"))
  vi.stubEnv(
    "GROK_CREDENTIALS",
    join(tmpdir(), "yakitori-goal-missing-auth.json"),
  )
})

afterEach(async () => {
  for (const application of applications) await application.close()
  applications.clear()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
  vi.unstubAllEnvs()
})

async function app(stream: StreamFn, existingRoot?: string) {
  const rootDir =
    existingRoot ?? (await mkdtemp(join(tmpdir(), "yakitori-goal-runtime-")))
  if (existingRoot === undefined) roots.push(rootDir)
  const workspace = join(rootDir, "workspace")
  await mkdir(workspace, { recursive: true })
  const application = await createYakitoriApplication({
    rootDir,
    workspace,
    userConfigPath: join(rootDir, "config.toml"),
    provider: "faux",
    model: "scripted",
    modelDirectory: { listModels: async () => [] },
    stream,
  })
  applications.add(application)
  return { application, rootDir }
}

async function close(application: YakitoriApplication): Promise<void> {
  applications.delete(application)
  await application.close()
}

function body<T>(result: ApiHandlerResult<T>): T {
  if (!result.ok)
    throw new Error(`${result.body.error.code}: ${result.body.error.message}`)
  return result.body
}

const final = (
  text: string,
  usage?: ModelResponse["usage"],
): ModelResponse => ({
  stopReason: "end_turn",
  content: [{ type: "text", text }],
  ...(usage === undefined ? {} : { usage }),
})

function step(
  response: ModelResponse,
  gate?: ReturnType<typeof deferred<void>>,
) {
  return { response, gate, entered: deferred<ModelRequest>() }
}

function script(...steps: ReturnType<typeof step>[]) {
  const requests: ModelRequest[] = []
  const stream: StreamFn = async function* (request) {
    const next = steps[requests.length]
    requests.push(request)
    if (next === undefined)
      throw new Error(`Unexpected model request ${requests.length}.`)
    next.entered.resolve(request)
    if (next.gate !== undefined && !request.signal?.aborted) {
      const aborted = deferred<void>()
      const onAbort = () => aborted.resolve()
      request.signal?.addEventListener("abort", onAbort, { once: true })
      try {
        await Promise.race([next.gate.promise, aborted.promise])
      } finally {
        request.signal?.removeEventListener("abort", onAbort)
      }
    }
    if (request.signal?.aborted) yield { type: "cancelled" }
    else yield { type: "response", response: next.response }
  }
  return { stream, requests }
}

async function readGoal(
  application: YakitoriApplication,
  sessionId: string,
): Promise<ThreadGoal | null> {
  return body(await application.handlers.readGoal({ sessionId })).goal
}

async function createSession(
  application: YakitoriApplication,
): Promise<string> {
  return body(await application.handlers.createSession({ title: "Goal test" }))
    .session.id
}

describe("goal handlers", () => {
  it("admits the user request that loads an active goal thread", async () => {
    const first = step(final("Progress"), deferred<void>())
    const { application, rootDir } = await app(script(first).stream)
    const sessionId = await createSession(application)
    body(
      await application.handlers.setGoal({
        sessionId,
        objective: "Do the work",
      }),
    )
    await first.entered.promise
    await close(application)
    const next = step(final("Response"), deferred<void>())
    const provider = script(next)
    const { application: reopened } = await app(provider.stream, rootDir)
    const submitted = await reopened.handlers.admitInput({
      sessionId,
      requestId: "request_user_resume",
      content: { kind: "text", text: "Actually do this first" },
    })
    expect(submitted).toMatchObject({ ok: true })
    const request = await next.entered.promise
    expect(
      request.messages.some(
        (message) =>
          message.role === "user" &&
          message.content.some(
            (part) =>
              part.type === "text" && part.text === "Actually do this first",
          ),
      ),
    ).toBe(true)
  })

  it("rejects invalid goal fields without changing durable state", async () => {
    const provider = script()
    const { application } = await app(provider.stream)
    const sessionId = await createSession(application)
    const invalid = [
      { objective: "" },
      { objective: "   " },
      { objective: 42 },
      { status: "finished" },
      { status: null },
      { tokenBudget: 0 },
      { tokenBudget: -1 },
      { tokenBudget: 1.5 },
      { tokenBudget: Number.MAX_SAFE_INTEGER + 1 },
      { tokenBudget: "100" },
      { tokensUsed: 500 },
      { inputId: "" },
    ]
    for (const fields of invalid) {
      expect(
        await application.handlers.setGoal({
          sessionId,
          objective: "Should not save",
          ...fields,
        }),
      ).toMatchObject({ ok: false, body: { error: { code: "invalid_input" } } })
      expect(await readGoal(application, sessionId)).toBeNull()
    }
    const original = body(
      await application.handlers.setGoal({
        sessionId,
        objective: "Keep this goal",
        status: "paused",
        tokenBudget: 80,
      }),
    ).goal
    for (const fields of invalid) {
      expect(
        await application.handlers.setGoal({ sessionId, ...fields }),
      ).toMatchObject({ ok: false })
      expect(await readGoal(application, sessionId)).toEqual(original)
    }
    expect(provider.requests).toHaveLength(0)
  })

  it("requires restoring an archived conversation before creating or resuming an active goal", async () => {
    const provider = script()
    const { application } = await app(provider.stream)
    const sessionId = await createSession(application)
    body(
      await application.handlers.updateSidebar({
        type: "session",
        sessionId,
        archived: true,
      }),
    )
    for (const fields of [
      { objective: "Must not start" },
      { objective: "Must not start", status: "active" },
    ]) {
      expect(
        await application.handlers.setGoal({ sessionId, ...fields }),
      ).toMatchObject({ ok: false, body: { error: { code: "conflict" } } })
      expect(await readGoal(application, sessionId)).toBeNull()
    }
    const paused = body(
      await application.handlers.setGoal({
        sessionId,
        objective: "Saved for later",
        status: "paused",
      }),
    ).goal
    expect(
      await application.handlers.setGoal({ sessionId, status: "active" }),
    ).toMatchObject({ ok: false })
    expect(await readGoal(application, sessionId)).toEqual(paused)
    expect(provider.requests).toHaveLength(0)
  })

  it("preserves the goal when a restored tool allowlist cannot complete it", async () => {
    const provider = script()
    const { application, rootDir } = await app(provider.stream)
    const sessionId = await createSession(application)
    const paused = body(
      await application.handlers.setGoal({
        sessionId,
        objective: "Wait for an enabled completion tool",
        status: "paused",
      }),
    ).goal
    const selection = { provider: "faux", model: "scripted" }
    await application.threadStore.appendItems(sessionId, [
      {
        type: "turn_context",
        context: {
          turnId: "turn_configured_tools",
          selection,
          configuration: SessionConfiguration.create({
            selection,
            workspaceRoot: join(rootDir, "workspace"),
            enabledTools: ["get_goal", "read_file"],
            approvalPolicy: "always_approve",
            promptCacheKey: "goal-tools-disabled",
          }).snapshot,
        },
      },
    ])
    await application.threadStore.persistThread(
      sessionId,
      PersistContext.TurnStart,
    )
    await application.threadStore.flushThread(sessionId)
    await application.threadManager.closeThread(sessionId)
    for (const live of [false, true]) {
      if (live) await application.threadManager.resumeThread(sessionId)
      expect(
        await application.handlers.setGoal({ sessionId, status: "active" }),
      ).toMatchObject({ ok: false, body: { error: { code: "conflict" } } })
      expect(await readGoal(application, sessionId)).toEqual(paused)
    }
    expect(provider.requests).toHaveLength(0)
  })

  it("durably clears only the requested goal and removes a deleted session's goal", async () => {
    const { application, rootDir } = await app(script().stream)
    const clearedId = await createSession(application)
    const deletedId = await createSession(application)
    const retainedId = await createSession(application)
    for (const sessionId of [clearedId, deletedId, retainedId])
      body(
        await application.handlers.setGoal({
          sessionId,
          objective: "Keep until cleared",
          status: "paused",
          tokenBudget: 100,
        }),
      )
    const retained = await readGoal(application, retainedId)
    body(await application.handlers.clearGoal({ sessionId: clearedId }))
    expect(await readGoal(application, clearedId)).toBeNull()
    body(await application.handlers.deleteSession({ sessionId: deletedId }))
    expect(await application.threadStore.readThread(deletedId)).toBeUndefined()
    await close(application)
    const persisted = new SqliteGoalStore(
      join(rootDir, "sessions", "thread-goals.sqlite"),
    )
    try {
      expect(persisted.read(clearedId)).toBeUndefined()
      expect(persisted.read(deletedId)).toBeUndefined()
      expect(persisted.read(retainedId)).toEqual(retained)
    } finally {
      persisted.close()
    }
  })

  it("persists a paused goal and its conversation before any model turn", async () => {
    const { application, rootDir } = await app(script().stream)
    const sessionId = await createSession(application)
    const goal = body(
      await application.handlers.setGoal({
        sessionId,
        objective: "Work when resumed",
        status: "paused",
      }),
    ).goal
    await close(application)
    const { application: reopened } = await app(script().stream, rootDir)
    expect(await readGoal(reopened, sessionId)).toEqual(goal)
    const updated = body(
      await reopened.handlers.setGoal({ sessionId, tokenBudget: 50 }),
    ).goal
    expect(updated).toMatchObject({
      id: goal.id,
      status: "paused",
      tokenBudget: 50,
    })
    expect(reopened.threadManager.getThread(sessionId)).toBeUndefined()
  })
})
