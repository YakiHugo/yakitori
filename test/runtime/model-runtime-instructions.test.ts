import { describe, expect, it } from "vitest"
import type { ModelSelection } from "../../src/kernel/index.ts"
import { SessionConfiguration } from "../../src/runtime/session-configuration.ts"
import {
  buildWorldState,
  diffWorldState,
} from "../../src/runtime/world-state.ts"

const agent = {
  rootSessionId: "session_1",
  path: "/root",
  taskName: "root",
  agentType: "general" as const,
  depth: 0,
  maxDepth: 2,
  maxConcurrentAgents: 4,
}
const environment = {
  workspaceRoot: "/workspace",
  workingDirectory: "/workspace",
  isGitRepository: true,
  platform: "darwin",
  osVersion: "test",
  currentDate: "2026-11-17",
  timezone: "Asia/Shanghai",
}

function state(selection: ModelSelection) {
  const configuration = SessionConfiguration.create({
    selection,
    workspaceRoot: "/workspace",
    promptCacheKey: "test",
    enabledTools: ["spawn_agent", "exec_command", "write_stdin"],
    approvalPolicy: "always_approve",
  }).resolveStep(selection)
  return buildWorldState({ configuration, multiAgent: agent, environment })
}

describe("model runtime instructions", () => {
  it.each([
    { provider: "openai", model: "gpt-6.1-sol" },
    { provider: "codex", model: "gpt-6.1-terra" },
    { provider: "openai", model: "gpt-6-sol" },
    { provider: "codex", model: "gpt-5.6-sol" },
  ])("defaults $provider/$model to explicitly requested delegation", (selection) => {
    const fragment = diffWorldState(
      undefined,
      state(selection),
    )?.fragments.find(({ id }) => id === "multi_agent")
    expect(fragment?.text).toContain("Spawn sub-agents only when")
    expect(fragment?.text).toContain("Otherwise complete the work locally")
    expect(fragment?.text).not.toContain(
      "Proactive multi-agent delegation is active",
    )
  })

  it("replaces delegation policy across effort and model changes", () => {
    const selection = { provider: "codex", model: "gpt-6.1-sol" }
    const ultra = diffWorldState(
      undefined,
      state({ ...selection, effort: "ultra" }),
    )
    expect(
      ultra?.fragments.find(({ id }) => id === "multi_agent")?.text,
    ).toContain("Proactive multi-agent delegation is active")

    const max = diffWorldState(
      ultra?.snapshot,
      state({ ...selection, effort: "max" }),
    )
    expect(max?.fragments.map(({ id }) => id)).toEqual(["multi_agent"])
    expect(max?.fragments[0]?.text).toContain(
      "Earlier model-specific delegation instructions no longer apply",
    )
    expect(max?.fragments[0]?.text).toContain("Spawn sub-agents only when")

    const grokSelection = { provider: "grok", model: "grok-4.7" }
    const grokState = state(grokSelection)
    const grok = diffWorldState(max?.snapshot, grokState)
    expect(grok?.fragments.map(({ id }) => id)).toEqual([
      "model",
      "multi_agent",
      "tools",
    ])
    expect(grok?.fragments[1]?.text).toContain(
      "You may delegate concrete, bounded subtasks",
    )
    expect(grok?.fragments[1]?.text).not.toContain("Spawn sub-agents only when")
    expect(diffWorldState(grok?.snapshot, grokState)).toBeUndefined()
  })

  it("reasserts host contracts after a new model instruction body", () => {
    const first = diffWorldState(
      undefined,
      state({
        provider: "openai",
        model: "gpt-6.1-sol",
      }),
    )
    const changed = diffWorldState(
      first?.snapshot,
      state({
        provider: "openai",
        model: "gpt-6.1-terra",
      }),
    )
    expect(changed?.fragments.map(({ id }) => id)).toEqual([
      "model",
      "multi_agent",
      "tools",
    ])
    const tools = changed?.fragments.find(({ id }) => id === "tools")?.text
    expect(tools).toContain("exec_command runs shell text")
    expect(tools).toContain(
      "Provider-specific wrappers such as <user_query> are formatting",
    )
    expect(tools).toContain(
      "There are no automatic command-completion reminders",
    )
  })
})
