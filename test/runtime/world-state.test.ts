import { describe, expect, it } from "vitest"
import { SessionConfiguration } from "../../src/runtime/session-configuration.ts"
import type { ProjectInstructions } from "../../src/runtime/project-instructions.ts"
import {
  buildWorldStateFromSnapshot,
  diffWorldState,
} from "../../src/runtime/world-state.ts"
import { applyJsonMergePatch } from "../../src/kernel/json-equality.ts"

describe("world state", () => {
  it("emits one full baseline, no duplicate, then section patches", () => {
    const initial = worldState(projectInstructions("rules a"))
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
    expect(diffWorldState(full?.snapshot, initial)).toBeUndefined()

    const replacement = diffWorldState(
      full?.snapshot,
      worldState(projectInstructions("rules b")),
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

    const removed = diffWorldState(full?.snapshot, worldState())
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

  it("round-trips nested patches and ignores object key order", () => {
    const previous = {
      kept: { same: true, changed: "before", removed: true },
      removedSection: { value: true },
    }
    const current = {
      kept: { changed: "after", same: true },
    }
    const patch = diffWorldState(
      { environment: previous },
      {
        sections: [
          {
            id: "environment",
            snapshot: current,
            renderDiff: () => [],
          },
        ],
      },
    )

    expect(patch?.state).toEqual({
      environment: {
        kept: { changed: "after", removed: null },
        removedSection: null,
      },
    })
    expect(
      applyJsonMergePatch({ environment: previous }, patch?.state ?? {}),
    ).toEqual({ environment: current })
    expect(
      diffWorldState(
        { environment: { kept: { same: true, changed: "after" } } },
        {
          sections: [
            {
              id: "environment",
              snapshot: current,
              renderDiff: () => {
                throw new Error("logically equal state must not render")
              },
            },
          ],
        },
      ),
    ).toBeUndefined()
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

  it("only names collaboration tools when the Step exposes them", () => {
    const context = {
      rootSessionId: "session_1",
      path: "/root",
      taskName: "root",
      agentType: "general" as const,
      depth: 0,
      maxDepth: 2,
      maxConcurrentAgents: 4,
    }
    const withoutTool = diffWorldState(
      undefined,
      worldState(undefined, "2026-08-21", [], context),
    )
    const withTool = diffWorldState(
      undefined,
      worldState(undefined, "2026-08-21", ["spawn_agent"], context),
    )

    expect(withoutTool?.fragments[0]?.text).not.toContain("spawn_agent")
    expect(withTool?.fragments[0]?.text).toContain("spawn")
  })
})

function worldState(
  project?: ProjectInstructions,
  currentDate = "2026-08-21",
  enabledTools: readonly string[] = [],
  multiAgent?: Parameters<typeof buildWorldStateFromSnapshot>[0]["multiAgent"],
) {
  const sessionConfiguration = SessionConfiguration.create({
    promptCacheKey: "session-cache",
    selection: { provider: "codex", model: "gpt-5.6-sol" },
    workspaceRoot: "/workspace",
    enabledTools,
    approvalPolicy: "always_approve",
  })
  return buildWorldStateFromSnapshot({
    configuration: sessionConfiguration.resolveTurn(
      sessionConfiguration.snapshot.defaultTarget,
    ),
    environment: {
      workspaceRoot: "/workspace",
      workingDirectory: "/workspace",
      isGitRepository: true,
      platform: "darwin",
      osVersion: "test",
      currentDate,
      timezone: "Asia/Shanghai",
    },
    ...(multiAgent === undefined ? {} : { multiAgent }),
    ...(project === undefined ? {} : { projectInstructions: project }),
  })
}

function projectInstructions(text: string): ProjectInstructions {
  return {
    directory: "/workspace",
    text,
  }
}
