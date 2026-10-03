import { describe, expect, it, vi } from "vitest"
import type { ThreadGoal } from "../../src/core/goal.ts"
import {
  createGoalTools,
  GoalToolError,
  type GoalToolService,
} from "../../src/runtime/tools/goal.ts"
import {
  createDefaultTools,
  createToolRegistry,
} from "../../src/runtime/tools/registry.ts"

const context = {
  workspaceRoot: "/workspace",
  threadId: "thread_goal_tools",
  turnId: "turn_goal_tools",
}

const goal: ThreadGoal = {
  id: "goal_test",
  threadId: context.threadId,
  objective: "Verify the build",
  status: "active",
  tokensUsed: 40,
  timeUsedSeconds: 12,
  createdAt: "2026-10-03T00:00:00.000Z",
  updatedAt: "2026-10-03T00:00:12.000Z",
}

function setup(overrides: Partial<GoalToolService> = {}) {
  const service = {
    get: vi.fn<GoalToolService["get"]>().mockResolvedValue(goal),
    create: vi.fn<GoalToolService["create"]>().mockResolvedValue(goal),
    update: vi.fn<GoalToolService["update"]>().mockResolvedValue(goal),
    ...overrides,
  }
  const registry = createToolRegistry(createGoalTools(service))
  const router = registry.finalize({
    enabledTrustedTools: new Set(registry.trustedToolNames()),
    customToolMode: "function",
    wireProtocol: "eager",
  })
  return { service, router }
}

describe("goal model tools", () => {
  it("registers goal tools only with a service and honors the trusted allowlist", () => {
    const { service } = setup()
    const absent = createToolRegistry(createDefaultTools())
    const present = createToolRegistry(
      createDefaultTools({ goalService: service }),
    )
    const names = ["get_goal", "create_goal", "update_goal"]

    expect(absent.trustedToolNames()).not.toEqual(expect.arrayContaining(names))
    expect(present.trustedToolNames()).toEqual(expect.arrayContaining(names))
    const router = present.finalize({
      enabledTrustedTools: new Set(["get_goal"]),
      customToolMode: "function",
      wireProtocol: "eager",
    })
    expect(router.definitions.map(({ name }) => name)).toEqual(["get_goal"])
    expect(router.get("create_goal")).toBeUndefined()
    expect(router.get("update_goal")).toBeUndefined()
  })

  it("rejects malformed input and model attempts to resume or change limits before dispatch", async () => {
    const { service, router } = setup()
    const invalid = [
      ["get_goal", null],
      ["get_goal", []],
      ["get_goal", { threadId: "another_thread" }],
      ["create_goal", {}],
      ["create_goal", { objective: "  " }],
      ["create_goal", { objective: "Build", token_budget: null }],
      ["create_goal", { objective: "Build", token_budget: 0 }],
      ["create_goal", { objective: "Build", token_budget: -1 }],
      ["create_goal", { objective: "Build", token_budget: 1.5 }],
      [
        "create_goal",
        { objective: "Build", token_budget: Number.POSITIVE_INFINITY },
      ],
      [
        "create_goal",
        { objective: "Build", token_budget: Number.MAX_SAFE_INTEGER + 1 },
      ],
      ["create_goal", { objective: "Build", status: "active" }],
      ["update_goal", { status: "active" }],
      ["update_goal", { status: "budget_limited" }],
      ["update_goal", { status: "usage_limited" }],
      ["update_goal", { status: "paused", objective: "Replace" }],
      ["update_goal", { status: "complete", token_budget: 100 }],
    ] as const
    for (const [name, input] of invalid) {
      await expect(router.execute(name, input, context)).resolves.toMatchObject(
        {
          ok: false,
          code: "invalid_tool_input",
        },
      )
    }
    expect(service.get).not.toHaveBeenCalled()
    expect(service.create).not.toHaveBeenCalled()
    expect(service.update).not.toHaveBeenCalled()
  })

  it("attributes a normalized objective and optional budget to the calling thread and turn", async () => {
    const { service, router } = setup()
    await router.execute(
      "create_goal",
      { objective: "  Verify the build  " },
      context,
    )
    await router.execute(
      "create_goal",
      { objective: "Verify the build", token_budget: 100 },
      context,
    )

    expect(service.create).toHaveBeenNthCalledWith(
      1,
      context.threadId,
      {
        objective: "Verify the build",
      },
      context.turnId,
    )
    expect(service.create).toHaveBeenNthCalledWith(
      2,
      context.threadId,
      {
        objective: "Verify the build",
        tokenBudget: 100,
      },
      context.turnId,
    )
  })

  it("reports no goal without fabricating usage or a budget", async () => {
    const { service, router } = setup({
      get: vi.fn().mockResolvedValue(undefined),
    })
    await expect(
      router.execute("get_goal", {}, context),
    ).resolves.toMatchObject({
      ok: true,
      output: {
        goal: null,
        remainingTokens: null,
        completionBudgetReport: null,
      },
    })
    expect(service.get).toHaveBeenCalledWith(context.threadId)
  })

  it("projects remaining budget and final usage from the authoritative service result", async () => {
    const { service, router } = setup({
      get: async () => ({ ...goal, tokenBudget: 100 }),
      update: vi
        .fn()
        .mockResolvedValue({
          ...goal,
          tokenBudget: 100,
          tokensUsed: 120,
          status: "complete",
        }),
    })
    await expect(
      router.execute("get_goal", {}, context),
    ).resolves.toMatchObject({
      ok: true,
      output: { remainingTokens: 60, completionBudgetReport: null },
    })
    const result = await router.execute(
      "update_goal",
      { status: "complete" },
      context,
    )
    expect(service.update).toHaveBeenCalledWith(
      context.threadId,
      "complete",
      context.turnId,
    )
    expect(result).toMatchObject({
      ok: true,
      output: {
        goal: { status: "complete", tokensUsed: 120, timeUsedSeconds: 12 },
        remainingTokens: 0,
        completionBudgetReport:
          "Goal completed using 120 of 100 budgeted tokens.",
      },
    })
    expect(JSON.parse(result.content)).toEqual(result.output)
  })

  it("requires thread attribution for every goal operation", async () => {
    const { service, router } = setup()
    for (const [name, input] of [
      ["get_goal", {}],
      ["create_goal", { objective: "Build" }],
      ["update_goal", { status: "paused" }],
    ] as const) {
      await expect(
        router.execute(name, input, { workspaceRoot: "/workspace" }),
      ).resolves.toMatchObject({
        ok: false,
        code: "goal_unavailable",
      })
    }
    expect(service.get).not.toHaveBeenCalled()
    expect(service.create).not.toHaveBeenCalled()
    expect(service.update).not.toHaveBeenCalled()
  })

  it("reports expected state rejection while allowing unexpected failures to surface", async () => {
    const unexpected = new Error("Storage invariant failed")
    const { router } = setup({
      create: async () => {
        throw new GoalToolError(
          "unfinished_goal",
          "Complete the current goal before creating another.",
        )
      },
      update: async () => {
        throw unexpected
      },
    })
    await expect(
      router.execute("create_goal", { objective: "Build" }, context),
    ).resolves.toMatchObject({
      ok: false,
      code: "unfinished_goal",
    })
    await expect(
      router.execute("update_goal", { status: "blocked" }, context),
    ).rejects.toBe(unexpected)
  })
})
