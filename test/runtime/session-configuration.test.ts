import { describe, expect, it } from "vitest"
import { createSessionExecutionPolicy } from "../../src/runtime/limits.ts"
import {
  createTurnContext,
  SessionConfiguration,
} from "../../src/runtime/session-configuration.ts"

function resolveSessionConfiguration(
  input: Omit<
    Parameters<typeof SessionConfiguration.create>[0],
    "promptCacheKey"
  >,
) {
  const session = SessionConfiguration.create({
    ...input,
    promptCacheKey: "session-cache",
  })
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
      instructionProfileId: "codex",
      baseInstructionsRevision: configuration.baseInstructions.revision,
      modelInstructionsRevision: configuration.modelInstructions.revision,
      modelContextWindowTokens: 272_000,
      effectiveModelContextWindowTokens: 258_400,
      executionPolicy: {
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
      executionPolicy: createSessionExecutionPolicy({
        modelVisibleContextBytes: 123_456,
      }),
    })
    const turn = createTurnContext({
      configuration,
      mateId: "mate_1",
      mateRevisionId: "mate_revision_1",
    })

    expect(turn.execution.executionPolicy.modelVisibleContextBytes).toBe(
      123_456,
    )
  })

  it("restores the exact persisted base instructions instead of re-resolving them", () => {
    const created = SessionConfiguration.create({
      promptCacheKey: "session-cache",
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

  it("persists custom base instructions across model changes", () => {
    const session = SessionConfiguration.create({
      promptCacheKey: "tree-cache",
      selection: { provider: "codex", model: "gpt-5.6-sol" },
      workspaceRoot: "/workspace",
      enabledTools: [],
      approvalPolicy: "never",
      baseInstructions: "  Follow the custom harness contract.  ",
    })
    const switched = session.resolveTurn({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    })

    expect(session.snapshot.baseInstructions).toEqual({
      text: "Follow the custom harness contract.",
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      provenance: { type: "custom" },
    })
    expect(switched).toMatchObject({
      promptCacheKey: "tree-cache",
      baseInstructions: { text: "Follow the custom harness contract." },
    })
    expect(switched.modelInstructions.text).not.toBe(
      switched.baseInstructions.text,
    )
  })

  it("persists cache identity as required session metadata", () => {
    const created = SessionConfiguration.create({
      promptCacheKey: "persisted-cache",
      selection: { provider: "codex", model: "gpt-5.6-sol" },
      workspaceRoot: "/workspace",
      enabledTools: [],
      approvalPolicy: "never",
    })
    expect(
      SessionConfiguration.restore(created.snapshot).resolveTurn(
        created.snapshot.defaultTarget,
      ).promptCacheKey,
    ).toBe("persisted-cache")
  })

  it("rejects an explicitly unsupported effort or speed", () => {
    expect(() =>
      SessionConfiguration.create({
        promptCacheKey: "session-cache",
        selection: {
          provider: "codex",
          model: "gpt-5.5",
          effort: "max",
        },
        workspaceRoot: "/workspace",
        enabledTools: [],
        approvalPolicy: "never",
      }),
    ).toThrow("Reasoning effort max is not supported")
    expect(() =>
      SessionConfiguration.create({
        promptCacheKey: "session-cache",
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
