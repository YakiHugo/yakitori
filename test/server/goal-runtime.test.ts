import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ThreadGoal } from "../../src/core/goal.ts"
import type {
  ModelRequest,
  ModelResponse,
  StreamFn,
} from "../../src/runtime/model.ts"
import type { UserShellEnv } from "../../src/runtime/user-shell-env.ts"
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
  vi.restoreAllMocks()
})

async function app(
  stream: StreamFn,
  existingRoot?: string,
  userShellEnv?: UserShellEnv,
) {
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
    ...(userShellEnv === undefined ? {} : { userShellEnv }),
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
const complete: ModelResponse = {
  stopReason: "tool_use",
  content: [
    {
      type: "tool_call",
      id: "complete_goal",
      name: "update_goal",
      input: { status: "complete" },
    },
  ],
}

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

async function idle(
  application: YakitoriApplication,
  sessionId: string,
): Promise<void> {
  const thread = application.threadManager.getThread(sessionId)
  if (thread === undefined || thread.status === "idle") return
  await new Promise<void>((resolve) => {
    const unsubscribe = thread.subscribeStatus((status) => {
      if (status !== "idle") return
      unsubscribe()
      resolve()
    })
  })
  await application.threadStore.flushThread(sessionId)
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

describe("goal runtime", () => {
  it("continues after a final answer until the model completes the goal, using developer context", async () => {
    const first = step(final("Made progress"))
    const finish = step(complete)
    const wrap = step(final("The goal is complete"))
    const provider = script(first, finish, wrap)
    const { application } = await app(provider.stream)
    const sessionId = await createSession(application)
    body(
      await application.handlers.setGoal({
        sessionId,
        objective: "Implement the complete feature",
      }),
    )
    const request = await first.entered.promise
    await wrap.entered.promise
    await idle(application, sessionId)

    expect(
      request.messages.some(
        (message) =>
          message.role === "developer" &&
          JSON.stringify(message).includes("Implement the complete feature"),
      ),
    ).toBe(true)
    expect(
      request.messages.some(
        (message) => message.role === "user" && message.context === undefined,
      ),
    ).toBe(false)
    expect((await readGoal(application, sessionId))?.status).toBe("complete")
    const stored = await application.threadStore.readThread(sessionId)
    expect(
      stored?.rollout.filter(({ item }) => item.type === "turn_started"),
    ).toHaveLength(2)
    expect(
      stored?.rollout.some(
        ({ item }) =>
          item.type === "response_item" &&
          item.item.item.role === "user" &&
          item.item.item.context === undefined,
      ),
    ).toBe(false)
    expect(
      body(await application.handlers.readSession({ sessionId })).session.counts
        .inputs,
    ).toBe(0)
    expect(provider.requests).toHaveLength(3)
  })

  it("pauses continuation without aborting the running request and resumes from idle", async () => {
    const release = deferred<void>()
    const first = step(final("Current work finished"), release)
    const finish = step(complete)
    const wrap = step(final("Done after resume"))
    const provider = script(first, finish, wrap)
    const { application } = await app(provider.stream)
    const sessionId = await createSession(application)
    body(
      await application.handlers.setGoal({
        sessionId,
        objective: "Keep working",
      }),
    )
    const running = await first.entered.promise
    body(await application.handlers.setGoal({ sessionId, status: "paused" }))
    expect(running.signal?.aborted).toBe(false)
    release.resolve()
    await idle(application, sessionId)
    expect((await readGoal(application, sessionId))?.status).toBe("paused")
    expect(provider.requests).toHaveLength(1)

    body(await application.handlers.setGoal({ sessionId, status: "active" }))
    await wrap.entered.promise
    await idle(application, sessionId)
    expect((await readGoal(application, sessionId))?.status).toBe("complete")
    expect(provider.requests).toHaveLength(3)
  })

  it("explicit cancellation pauses the goal and interrupts the current turn", async () => {
    const first = step(final("Unreachable result"), deferred<void>())
    const provider = script(first)
    const { application } = await app(provider.stream)
    const sessionId = await createSession(application)
    body(
      await application.handlers.setGoal({
        sessionId,
        objective: "Keep working",
      }),
    )
    const request = await first.entered.promise
    const active = body(await application.handlers.readSession({ sessionId }))
      .session.activeTurnId
    expect(active).toBeDefined()
    body(await application.handlers.cancelTurn({ sessionId, turnId: active }))
    await idle(application, sessionId)
    expect(request.signal?.aborted).toBe(true)
    expect((await readGoal(application, sessionId))?.status).toBe("paused")
    const stored = await application.threadStore.readThread(sessionId)
    expect(
      stored?.rollout
        .filter(({ item }) => item.type === "turn_completed")
        .map(({ item }) =>
          item.type === "turn_completed" ? item.outcome : undefined,
        ),
    ).toEqual(["interrupted"])
    expect(provider.requests).toHaveLength(1)
  })

  it("excludes cached input tokens and accounts the finishing turn when a reduced budget is spent", async () => {
    const first = step(
      final("First progress", {
        inputTokens: 100,
        cacheReadInputTokens: 80,
        outputTokens: 5,
      }),
    )
    const release = deferred<void>()
    const second = step(
      {
        stopReason: "tool_use",
        content: [
          {
            type: "tool_call",
            id: "inspect_goal",
            name: "get_goal",
            input: {},
          },
        ],
        usage: { inputTokens: 90, cacheReadInputTokens: 70, outputTokens: 5 },
      },
      release,
    )
    const wrap = step(
      final("Budget spent; here is the remaining work", {
        inputTokens: 10,
        cacheReadInputTokens: 8,
        outputTokens: 3,
      }),
    )
    const provider = script(first, second, wrap)
    const { application } = await app(provider.stream)
    const sessionId = await createSession(application)
    body(
      await application.handlers.setGoal({
        sessionId,
        objective: "Work within the requested budget",
        tokenBudget: 50,
      }),
    )
    await second.entered.promise
    expect(await readGoal(application, sessionId)).toMatchObject({
      status: "active",
      tokensUsed: 25,
      tokenBudget: 50,
    })
    expect(
      body(await application.handlers.setGoal({ sessionId, tokenBudget: 25 }))
        .goal.status,
    ).toBe("budget_limited")
    release.resolve()
    const wrapRequest = await wrap.entered.promise
    await idle(application, sessionId)
    expect(await readGoal(application, sessionId)).toMatchObject({
      status: "budget_limited",
      tokensUsed: 55,
      tokenBudget: 25,
    })
    expect(JSON.stringify(wrapRequest.messages)).toContain("budget")
    expect(provider.requests).toHaveLength(3)
    const stored = await application.threadStore.readThread(sessionId)
    expect(
      stored?.rollout.filter(({ item }) => item.type === "turn_started"),
    ).toHaveLength(2)
  })

  it("preserves completed goals across restart and resumes active goals only after their thread loads", async () => {
    const completedWrap = step(final("Complete"))
    const activeWork = step(final("Still pursuing the goal"), deferred<void>())
    const provider = script(step(complete), completedWrap, activeWork)
    const { application, rootDir } = await app(provider.stream)
    const completedId = await createSession(application)
    body(
      await application.handlers.setGoal({
        sessionId: completedId,
        objective: "Finish and persist",
      }),
    )
    await completedWrap.entered.promise
    await idle(application, completedId)
    const completed = await readGoal(application, completedId)
    const activeId = await createSession(application)
    body(
      await application.handlers.setGoal({
        sessionId: activeId,
        objective: "Continue after loading",
      }),
    )
    await activeWork.entered.promise
    await close(application)

    const resumedFinish = step(complete)
    const resumedWrap = step(final("Completed after reload"))
    const resumedProvider = script(resumedFinish, resumedWrap)
    const { application: reopened } = await app(resumedProvider.stream, rootDir)
    expect(await readGoal(reopened, completedId)).toEqual(completed)
    expect((await readGoal(reopened, activeId))?.status).toBe("active")
    expect(reopened.threadManager.getThread(activeId)).toBeUndefined()
    expect(resumedProvider.requests).toHaveLength(0)
    await reopened.threadManager.resumeThread(activeId)
    await resumedWrap.entered.promise
    await idle(reopened, activeId)
    expect((await readGoal(reopened, activeId))?.status).toBe("complete")
  })

  it("rejects a stale model completion after the user replaces the goal", async () => {
    const release = deferred<void>()
    const oldCompletion = step(complete, release)
    const finishRelease = deferred<void>()
    const finalOldTurn = step(final("The old turn is over"), finishRelease)
    const provider = script(oldCompletion, finalOldTurn)
    const { application } = await app(provider.stream)
    const sessionId = await createSession(application)
    const original = body(
      await application.handlers.setGoal({
        sessionId,
        objective: "Original objective",
      }),
    ).goal
    await oldCompletion.entered.promise
    body(await application.handlers.clearGoal({ sessionId }))
    const replacement = body(
      await application.handlers.setGoal({
        sessionId,
        objective: "New objective",
      }),
    ).goal
    expect(replacement.id).not.toBe(original.id)
    release.resolve()
    await finalOldTurn.entered.promise
    expect(await readGoal(application, sessionId)).toMatchObject({
      id: replacement.id,
      status: "active",
      objective: "New objective",
    })
    body(await application.handlers.setGoal({ sessionId, status: "paused" }))
    finishRelease.resolve()
    await idle(application, sessionId)
    expect((await readGoal(application, sessionId))?.id).toBe(replacement.id)
  })

  it("inherits an independent goal snapshot and starts the fork on explicit resume", async () => {
    const first = step(final("Original answer"))
    const finish = step(complete)
    const wrap = step(final("Fork completed"))
    const provider = script(first, finish, wrap)
    const { application } = await app(provider.stream)
    const sessionId = await createSession(application)
    const admitted = body(
      await application.handlers.admitInput({
        sessionId,
        requestId: "request_fork_source",
        content: { kind: "text", text: "Original task" },
      }),
    )
    await first.entered.promise
    await idle(application, sessionId)
    body(
      await application.handlers.setGoal({
        sessionId,
        objective: "Carry the goal to the fork",
        status: "paused",
      }),
    )
    const forked = body(
      await application.handlers.forkSession({
        sessionId,
        atInputId: admitted.inputId,
        reason: "undo",
      }),
    )
    const forkId = forked.session.id
    const sourceGoal = await readGoal(application, sessionId)
    const forkGoal = await readGoal(application, forkId)
    expect(forkGoal).toMatchObject({
      threadId: forkId,
      objective: sourceGoal?.objective,
      status: "paused",
      tokensUsed: sourceGoal?.tokensUsed,
    })
    expect(forkGoal?.id).not.toBe(sourceGoal?.id)
    expect(provider.requests).toHaveLength(1)
    body(
      await application.handlers.setGoal({
        sessionId: forkId,
        status: "active",
      }),
    )
    await wrap.entered.promise
    await idle(application, forkId)
    expect((await readGoal(application, forkId))?.status).toBe("complete")
    expect((await readGoal(application, sessionId))?.status).toBe("paused")
  })
  it("stops after three empty automatic turns", async () => {
    const last = step(final(""))
    const provider = script(step(final("")), step(final("")), last)
    const { application } = await app(provider.stream)
    const sessionId = await createSession(application)
    body(
      await application.handlers.setGoal({
        sessionId,
        objective: "Make progress",
      }),
    )
    await last.entered.promise
    await idle(application, sessionId)
    expect((await readGoal(application, sessionId))?.status).toBe("blocked")
    expect(provider.requests).toHaveLength(3)
  })

  it("accepts completion established by the finishing turn after the budget is spent", async () => {
    const wrap = step(final("Finished within the last turn"))
    const provider = script(
      step({ ...complete, usage: { inputTokens: 7, outputTokens: 3 } }),
      wrap,
    )
    const { application } = await app(provider.stream)
    const sessionId = await createSession(application)
    body(
      await application.handlers.setGoal({
        sessionId,
        objective: "Finish this task",
        tokenBudget: 10,
      }),
    )
    await wrap.entered.promise
    await idle(application, sessionId)
    expect(await readGoal(application, sessionId)).toMatchObject({
      status: "complete",
      tokensUsed: 10,
    })
    expect(provider.requests).toHaveLength(2)
  })

  it("charges a real descendant's uncached usage to the active root goal", async () => {
    const childEntered = deferred<void>()
    const rootWaiting = deferred<void>()
    const releaseRoot = deferred<void>()
    const { application } = await app(async function* (request) {
      const child = request.messages.some(
        (message) =>
          message.role === "user" &&
          message.context === undefined &&
          message.content.some(
            (part) => part.text === "Inspect the child task",
          ),
      )
      if (child) {
        childEntered.resolve()
        yield {
          type: "response",
          response: final("Child findings", {
            inputTokens: 80,
            cacheReadInputTokens: 50,
            outputTokens: 7,
          }),
        }
      } else if (request.messages.some((message) => message.role === "tool")) {
        rootWaiting.resolve()
        await releaseRoot.promise
        yield { type: "response", response: final("Root progress") }
      } else {
        yield {
          type: "response",
          response: {
            stopReason: "tool_use",
            content: [
              {
                type: "tool_call",
                id: "spawn_child",
                name: "spawn_agent",
                input: {
                  task_name: "survey",
                  message: "Inspect the child task",
                },
              },
            ],
            usage: {
              inputTokens: 10,
              cacheReadInputTokens: 5,
              outputTokens: 5,
            },
          },
        }
      }
    })
    const sessionId = await createSession(application)
    body(
      await application.handlers.setGoal({
        sessionId,
        objective: "Delegate and inspect the result",
      }),
    )
    await Promise.all([childEntered.promise, rootWaiting.promise])
    const childId = (await application.threadStore.listThreadIds()).find(
      (id) => id !== sessionId,
    )
    expect(childId).toBeDefined()
    await idle(application, childId ?? "")
    expect((await readGoal(application, sessionId))?.tokensUsed).toBe(47)
    body(await application.handlers.setGoal({ sessionId, status: "paused" }))
    releaseRoot.resolve()
    await idle(application, sessionId)
    expect(await readGoal(application, childId ?? "")).toBeNull()
    expect((await readGoal(application, sessionId))?.tokensUsed).toBe(47)
  })

  it("keeps an active fork deferred until an actual user turn without pausing the source goal", async () => {
    const first = step(final("Original answer"))
    const active = step(final("Interrupted by fork"), deferred<void>())
    const wrap = step(final("Fork completed"))
    const provider = script(first, active, step(complete), wrap)
    const { application } = await app(provider.stream)
    const sessionId = await createSession(application)
    const admitted = body(
      await application.handlers.admitInput({
        sessionId,
        requestId: "request_fork_active",
        content: { kind: "text", text: "Original user task" },
      }),
    )
    await first.entered.promise
    await idle(application, sessionId)
    body(
      await application.handlers.setGoal({
        sessionId,
        objective: "Continue on the selected branch",
      }),
    )
    await active.entered.promise
    const forked = body(
      await application.handlers.forkSession({
        sessionId,
        atInputId: admitted.inputId,
        reason: "undo",
      }),
    )
    const forkId = forked.session.id
    expect((await readGoal(application, sessionId))?.status).toBe("active")
    expect((await readGoal(application, forkId))?.status).toBe("active")
    expect(provider.requests).toHaveLength(2)
    body(
      await application.handlers.admitInput({
        sessionId: forkId,
        requestId: "request_fork_continue",
        content: { kind: "text", text: "Continue this branch" },
      }),
    )
    await wrap.entered.promise
    await idle(application, forkId)
    expect((await readGoal(application, forkId))?.status).toBe("complete")
    expect((await readGoal(application, sessionId))?.status).toBe("active")
    expect(provider.requests).toHaveLength(4)
  })

  it("rejects completion for the old objective until the updated developer context is delivered", async () => {
    const release = deferred<void>()
    const first = step(complete, release)
    const finishRelease = deferred<void>()
    const finish = step(
      {
        stopReason: "tool_use",
        content: [
          {
            type: "tool_call",
            id: "complete_updated_goal",
            name: "update_goal",
            input: { status: "complete" },
          },
        ],
      },
      finishRelease,
    )
    const wrap = step(final("Updated objective achieved"))
    const provider = script(first, finish, wrap)
    const { application } = await app(provider.stream)
    const sessionId = await createSession(application)
    body(
      await application.handlers.setGoal({
        sessionId,
        objective: "Original objective",
      }),
    )
    const active = await first.entered.promise
    body(
      await application.handlers.setGoal({
        sessionId,
        objective: "Updated objective",
      }),
    )
    expect(active.signal?.aborted).toBe(false)
    release.resolve()
    const request = await finish.entered.promise
    expect((await readGoal(application, sessionId))?.status).toBe("active")
    finishRelease.resolve()
    await wrap.entered.promise
    await idle(application, sessionId)
    expect(
      request.messages.some(
        (message) =>
          message.role === "developer" &&
          message.context?.type === "goal" &&
          message.content.some((part) =>
            part.text.includes("Updated objective"),
          ),
      ),
    ).toBe(true)
    const stored = await application.threadStore.readThread(sessionId)
    expect(
      stored?.rollout.filter(({ item }) => item.type === "turn_started"),
    ).toHaveLength(1)
    expect(
      body(await application.handlers.readSession({ sessionId })).session.counts
        .inputs,
    ).toBe(0)
    expect((await readGoal(application, sessionId))?.status).toBe("complete")
  })

  it("carries fractional work across turns and excludes paused time", async () => {
    const firstRelease = deferred<void>()
    const secondRelease = deferred<void>()
    const finishRelease = deferred<void>()
    const first = step(final("First progress"), firstRelease)
    const second = step(final("Second progress"), secondRelease)
    const finish = step(complete, finishRelease)
    const wrap = step(final("Done"))
    const provider = script(first, second, finish, wrap)
    const { application } = await app(provider.stream)
    const sessionId = await createSession(application)
    let now = Date.now()
    vi.spyOn(Date, "now").mockImplementation(() => now)
    body(
      await application.handlers.setGoal({
        sessionId,
        objective: "Accumulate work time",
      }),
    )
    await first.entered.promise
    now += 600
    firstRelease.resolve()
    await second.entered.promise
    now += 600
    body(await application.handlers.setGoal({ sessionId, status: "paused" }))
    now += 5_000
    secondRelease.resolve()
    await idle(application, sessionId)
    expect((await readGoal(application, sessionId))?.timeUsedSeconds).toBe(1)
    body(await application.handlers.setGoal({ sessionId, status: "active" }))
    await finish.entered.promise
    now += 900
    finishRelease.resolve()
    await wrap.entered.promise
    await idle(application, sessionId)
    expect((await readGoal(application, sessionId))?.timeUsedSeconds).toBe(2)
  })

  it("lets the model create and complete a fresh goal in the same user turn", async () => {
    const firstWrap = step(final("Original goal completed"))
    const secondWrap = step(final("New goal completed"))
    const provider = script(
      step(complete),
      firstWrap,
      step({
        stopReason: "tool_use",
        content: [
          {
            type: "tool_call",
            id: "create_next_goal",
            name: "create_goal",
            input: { objective: "The explicitly requested next goal" },
          },
        ],
      }),
      step(complete),
      secondWrap,
    )
    const { application } = await app(provider.stream)
    const sessionId = await createSession(application)
    const original = body(
      await application.handlers.setGoal({
        sessionId,
        objective: "First goal",
      }),
    ).goal
    await firstWrap.entered.promise
    await idle(application, sessionId)
    body(
      await application.handlers.admitInput({
        sessionId,
        requestId: "request_create_next_goal",
        content: { kind: "text", text: "Create and complete the next goal" },
      }),
    )
    await secondWrap.entered.promise
    await idle(application, sessionId)
    const current = await readGoal(application, sessionId)
    expect(current).toMatchObject({
      status: "complete",
      objective: "The explicitly requested next goal",
    })
    expect(current?.id).not.toBe(original.id)
    expect(provider.requests).toHaveLength(5)
  })

  it("stops elapsed accounting when the thread closes while preserving its active goal", async () => {
    const first = step(final("Interrupted on close"), deferred<void>())
    const provider = script(first)
    const { application } = await app(provider.stream)
    const sessionId = await createSession(application)
    let now = Date.now()
    vi.spyOn(Date, "now").mockImplementation(() => now)
    body(
      await application.handlers.setGoal({
        sessionId,
        objective: "Resume after reopening",
      }),
    )
    await first.entered.promise
    now += 1_500
    body(await application.handlers.closeSession({ sessionId }))
    expect(application.threadManager.getThread(sessionId)).toBeUndefined()
    now += 10_000
    expect(await readGoal(application, sessionId)).toMatchObject({
      status: "active",
      timeUsedSeconds: 1,
    })
    expect(provider.requests).toHaveLength(1)
  })

  it("blocks after three turns whose commands cannot execute and no tool succeeds", async () => {
    const execute: ModelResponse = {
      stopReason: "tool_use",
      content: [
        {
          type: "tool_call",
          id: "run_command",
          name: "exec_command",
          input: { cmd: "true" },
        },
      ],
    }
    const last = step(final("Execution remains unavailable"))
    const provider = script(
      step(execute),
      step(final("First execution attempt failed")),
      step(execute),
      step(final("Second execution attempt failed")),
      step(execute),
      last,
    )
    const { application } = await app(provider.stream, undefined, {
      commandEnvironment: async () => ({
        shell: "invalid\0shell",
        env: {},
        warnings: [],
      }),
      probe: async () => "ready",
      shellName: async () => "missing-shell",
      shellSnapshot: async () => undefined,
    })
    const sessionId = await createSession(application)
    body(
      await application.handlers.setGoal({
        sessionId,
        objective: "Run the requested command",
      }),
    )
    await last.entered.promise
    await idle(application, sessionId)
    expect((await readGoal(application, sessionId))?.status).toBe("blocked")
    expect(provider.requests).toHaveLength(6)
    const stored = await application.threadStore.readThread(sessionId)
    const failures = stored?.rollout.filter(
      ({ item }) =>
        item.type === "item_completed" &&
        "error" in item.item &&
        item.item.error?.code === "exec_command_failed",
    )
    expect(failures).toHaveLength(3)
  })
})
