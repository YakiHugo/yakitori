import { describe, expect, it } from "vitest"
import type { SessionProjection } from "../../src/kernel/index.ts"
import { SessionConfiguration } from "../../src/runtime/session-configuration.ts"
import type { ProjectInstructions } from "../../src/runtime/project-instructions.ts"
import {
  buildWorldState,
  diffWorldState,
} from "../../src/runtime/world-state.ts"

describe("world state", () => {
  it("emits one full baseline, no duplicate, then section patches", () => {
    const initial = worldState(projectInstructions("revision_a", "rules a"))
    const full = diffWorldState(undefined, initial)

    expect(full).toMatchObject({
      full: true,
      state: {
        model: "codex/gpt-5.6-sol",
        environment: { currentDate: "2026-08-21" },
        "project.instructions": { text: "rules a" },
      },
    })
    expect(full?.fragments.map((fragment) => fragment.id)).toEqual([
      "project.instructions",
      "environment",
    ])
    expect(diffWorldState(full?.state, initial)).toBeUndefined()

    const replacement = diffWorldState(
      full?.state,
      worldState(projectInstructions("revision_b", "rules b")),
    )
    expect(replacement).toMatchObject({
      full: false,
      state: {
        "project.instructions": { text: "rules b" },
      },
      fragments: [
        {
          id: "project.instructions",
          text: expect.stringContaining("replace all previously supplied"),
        },
      ],
    })

    const removed = diffWorldState(full?.state, worldState())
    expect(removed).toMatchObject({
      full: false,
      state: {
        "project.instructions": { directory: null, text: null },
      },
      fragments: [
        {
          id: "project.instructions",
          text: expect.stringContaining("no longer apply"),
        },
      ],
    })
  })

  it("emits an environment replacement when the date changes", () => {
    const first = diffWorldState(undefined, worldState())
    const changed = diffWorldState(
      first?.state,
      worldState(undefined, "2026-08-22"),
    )

    expect(changed).toMatchObject({
      full: false,
      fragments: [
        {
          id: "environment",
          text: expect.stringContaining("The runtime environment changed"),
        },
      ],
    })
  })
})

function worldState(project?: ProjectInstructions, currentDate = "2026-08-21") {
  const sessionConfiguration = SessionConfiguration.create({
    promptCacheKey: "session-cache",
    selection: { provider: "codex", model: "gpt-5.6-sol" },
    workspaceRoot: "/workspace",
    enabledTools: [],
    approvalPolicy: "never",
  })
  return buildWorldState({
    configuration: sessionConfiguration.resolveTurn(
      sessionConfiguration.snapshot.defaultTarget,
    ),
    session: emptySession(),
    environment: {
      workspaceRoot: "/workspace",
      workingDirectory: "/workspace",
      isGitRepository: true,
      platform: "darwin",
      osVersion: "test",
      currentDate,
      timezone: "Asia/Shanghai",
    },
    ...(project === undefined ? {} : { projectInstructions: project }),
  })
}

function emptySession(): SessionProjection {
  return {
    id: "session_1",
    seq: 1,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
    conversationId: "session_1",
    worldStateUpdates: [],
    inputs: [],
    pendingInputs: [],
    completedTurns: [],
    failedTurns: [],
    cancelledTurns: [],
    interruptedTurns: [],
    items: [],
    permissions: [],
    tools: [],
    turns: [],
  }
}

function projectInstructions(
  revision: string,
  text: string,
): ProjectInstructions {
  return {
    directory: "/workspace",
    files: ["/workspace/AGENTS.md"],
    sources: [{ path: "/workspace/AGENTS.md", byteLength: text.length }],
    revision,
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
    truncated: false,
  }
}
