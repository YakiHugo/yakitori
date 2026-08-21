import { describe, expect, it } from "vitest"
import {
  createRuntimeLimits,
  createTurnContext,
  SessionConfiguration,
} from "../../src/index.ts"

function resolveSessionConfiguration(
  input: Parameters<typeof SessionConfiguration.create>[0],
) {
  const session = SessionConfiguration.create(input)
  return session.resolveTurn(input.selection)
}

describe("session configuration", () => {
  it("uses the Codex default capacity and its 95% effective window", () => {
    const configuration = resolveSessionConfiguration({
      selection: { provider: "codex", model: "gpt-5.6-sol" },
      workspaceRoot: "/workspace",
      enabledTools: ["read_file"],
      approvalPolicy: "auto_file_tools",
    })
    const turn = createTurnContext({
      configuration,
      mateId: "mate_1",
      mateRevisionId: "mate_revision_1",
    })

    expect(configuration.modelCapacity).toEqual({
      defaultContextWindowTokens: 272_000,
      contextWindowTokens: 272_000,
      maxContextWindowTokens: 872_000,
      effectiveContextWindowPercent: 95,
      effectiveContextWindowTokens: 258_400,
    })
    expect(turn.execution).toMatchObject({
      promptId: "gpt",
      baseInstructionsRevision: configuration.baseInstructions.revision,
      modelInstructionsRevision: configuration.modelInstructions.revision,
      modelContextWindowTokens: 272_000,
      effectiveModelContextWindowTokens: 258_400,
      limits: {
        modelVisibleContextBytes: 1_033_600,
        compactionTriggerContextBytes: 826_880,
        compactionRetainContextBytes: 165_376,
      },
    })
  })

  it("applies a configured window without exceeding the Codex maximum", () => {
    const configuration = resolveSessionConfiguration({
      selection: { provider: "codex", model: "gpt-5.6-sol" },
      workspaceRoot: "/workspace",
      enabledTools: [],
      approvalPolicy: "never",
      modelContextWindowTokens: 600_000,
    })

    expect(configuration.modelCapacity).toMatchObject({
      defaultContextWindowTokens: 272_000,
      contextWindowTokens: 600_000,
      maxContextWindowTokens: 872_000,
      effectiveContextWindowTokens: 570_000,
    })
    expect(() =>
      resolveSessionConfiguration({
        selection: { provider: "codex", model: "gpt-5.6-sol" },
        workspaceRoot: "/workspace",
        enabledTools: [],
        approvalPolicy: "never",
        modelContextWindowTokens: 900_000,
      }),
    ).toThrow("exceeds codex/gpt-5.6-sol maximum of 872000")
  })

  it("keeps an explicit byte budget instead of replacing it from capacity", () => {
    const configuration = resolveSessionConfiguration({
      selection: { provider: "codex", model: "gpt-5.6-sol" },
      workspaceRoot: "/workspace",
      enabledTools: [],
      approvalPolicy: "never",
      limits: createRuntimeLimits({ modelVisibleContextBytes: 123_456 }),
    })
    const turn = createTurnContext({
      configuration,
      mateId: "mate_1",
      mateRevisionId: "mate_revision_1",
    })

    expect(turn.execution.limits.modelVisibleContextBytes).toBe(123_456)
  })

  it("restores the exact persisted base instructions instead of re-resolving them", () => {
    const created = SessionConfiguration.create({
      selection: { provider: "codex", model: "gpt-5.6-sol" },
      workspaceRoot: "/workspace",
      enabledTools: ["read_file"],
      approvalPolicy: "never",
    })
    const restored = SessionConfiguration.restore({
      ...created.snapshot,
      baseInstructions: {
        ...created.snapshot.baseInstructions,
        text: "persisted session instructions",
        revision: "persisted-revision",
      },
    }).resolveTurn(created.snapshot.defaultTarget)

    expect(restored.baseInstructions).toEqual({
      id: "base.instructions",
      revision: "persisted-revision",
      text: "persisted session instructions",
    })
    expect(restored.modelInstructions.text).not.toBe(
      "persisted session instructions",
    )
  })

  it("fills runtime limits added to schema v1 when restoring an older snapshot", () => {
    const created = SessionConfiguration.create({
      selection: { provider: "codex", model: "gpt-5.6-sol" },
      workspaceRoot: "/workspace",
      enabledTools: ["read_file"],
      approvalPolicy: "never",
    })
    const { compactionRetainRatio: _removedLimit, ...legacyRuntimeLimits } =
      created.snapshot.runtimeLimits
    const restored = SessionConfiguration.restore({
      ...created.snapshot,
      runtimeLimits: legacyRuntimeLimits,
    })

    expect(restored.snapshot.runtimeLimits.compactionRetainRatio).toBe(
      createRuntimeLimits().compactionRetainRatio,
    )
  })

  it("rejects an explicitly unsupported effort or speed", () => {
    expect(() =>
      SessionConfiguration.create({
        selection: {
          provider: "codex",
          model: "gpt-5.6-sol",
          effort: "max",
        },
        workspaceRoot: "/workspace",
        enabledTools: [],
        approvalPolicy: "never",
      }),
    ).toThrow("Reasoning effort max is not supported")
    expect(() =>
      SessionConfiguration.create({
        selection: {
          provider: "codex",
          model: "gpt-5.6-sol",
          speed: "turbo",
        },
        workspaceRoot: "/workspace",
        enabledTools: [],
        approvalPolicy: "never",
      }),
    ).toThrow("Speed turbo is not supported")
  })
})
