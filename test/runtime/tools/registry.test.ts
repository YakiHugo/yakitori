import { describe, expect, it } from "vitest"
import { isModelMessage } from "../../../src/kernel/events.ts"
import {
  canonicalToolName,
  createToolRegistry,
  namespacedToolName,
  plainToolName,
} from "../../../src/runtime/tools/registry.ts"
import type {
  RuntimeTool,
  ToolExposure,
} from "../../../src/runtime/tools/types.ts"
import type { ToolName } from "../../../src/runtime/tools/tool-name.ts"

describe("finalized tool router", () => {
  it("advertises and dispatches the same enabled tool set", async () => {
    const registry = createToolRegistry([tool("read_file"), tool("grep")])
    const router = finalize(registry, new Set(["grep"]))

    expect(router.definitions.map((definition) => definition.name)).toEqual([
      "grep",
    ])
    expect(router.get("read_file")).toBeUndefined()
    await expect(
      router.execute("read_file", {}, { workspaceRoot: "/workspace" }),
    ).resolves.toMatchObject({
      ok: false,
      code: "unknown_tool",
      message: "Unknown or disabled tool: read_file",
    })
    await expect(
      router.execute("grep", {}, { workspaceRoot: "/workspace" }),
    ).resolves.toMatchObject({ ok: true, output: { name: "grep" } })
  })

  it("uses runtime parallel capability but never grants it to hidden or unknown tools", () => {
    const parallel = { ...tool("parallel"), supportsParallelToolCalls: true }
    const hidden = {
      ...tool("hidden"),
      exposure: "hidden" as const,
      supportsParallelToolCalls: true,
    }
    const registry = createToolRegistry([parallel, hidden])
    const router = finalize(registry, new Set(["parallel", "hidden"]))

    expect(router.supportsParallelToolCalls("parallel")).toBe(true)
    expect(router.supportsParallelToolCalls("hidden")).toBe(false)
    expect(router.supportsParallelToolCalls("missing")).toBe(false)
  })

  it("matches Codex builtin parallel opt-ins for exec and collaboration ordering", () => {
    const registry = createToolRegistry()
    const router = finalize(registry, new Set(registry.trustedToolNames()))

    expect(router.supportsParallelToolCalls("exec_command")).toBe(true)
    expect(router.supportsParallelToolCalls("read_file")).toBe(true)
    expect(router.supportsParallelToolCalls("spawn_agent")).toBe(false)
    expect(router.supportsParallelToolCalls("list_agents")).toBe(false)
  })

  it("rejects duplicate tool names before a Step is finalized", () => {
    expect(() => createToolRegistry([tool("grep"), tool("grep")])).toThrow(
      "Duplicate trusted tool name: grep",
    )
  })

  it("keeps namespaced identity, source, and exposure in one router snapshot", async () => {
    const registry = createToolRegistry([])
    const direct = identifiedTool(
      namespacedToolName("calendar", "create_event"),
      "direct",
    )
    const deferred = identifiedTool(
      namespacedToolName("calendar", "search_events"),
      "deferred",
      "deferred",
    )
    const hidden = identifiedTool(
      namespacedToolName("calendar", "refresh_token"),
      "hidden",
      "hidden",
    )
    expect(registry.registerExternal(direct, "calendar-server")).toBe(true)
    expect(registry.registerExternal(deferred, "calendar-server")).toBe(true)
    expect(registry.registerExternal(hidden, "calendar-server")).toBe(true)
    const router = finalize(registry, new Set())

    expect(router.definitions.map((definition) => definition.name)).toEqual([
      "calendar__create_event",
      "tool_search",
    ])
    expect(router.source("calendar__create_event")).toEqual({
      kind: "external",
      sourceId: "calendar-server",
    })
    expect(router.exposure("calendar__search_events")).toBe("deferred")
    expect(router.exposure("calendar__refresh_token")).toBe("hidden")
    expect(router.search("search calendar events")).toMatchObject([
      { name: "calendar__search_events" },
    ])
    await expect(
      router.execute(
        "tool_search",
        { query: "search calendar events" },
        { workspaceRoot: "/workspace" },
      ),
    ).resolves.toMatchObject({
      ok: true,
      output: { tools: [{ name: "calendar__search_events" }] },
    })
    await expect(
      router.execute(
        "calendar__search_events",
        {},
        { workspaceRoot: "/workspace" },
      ),
    ).resolves.toMatchObject({ ok: true, content: "deferred" })
  })

  it("adds newly registered external tools to the next Step without mutating the trusted allowlist", () => {
    const registry = createToolRegistry([tool("read_file")])
    const trustedTools = new Set(["read_file"])
    const beforeRegistration = finalize(registry, trustedTools)

    expect(
      registry.registerExternal(
        identifiedTool(namespacedToolName("calendar", "list_events")),
        "calendar-server",
      ),
    ).toBe(true)
    const afterRegistration = finalize(registry, trustedTools)

    expect(
      beforeRegistration.definitions.map((definition) => definition.name),
    ).toEqual(["read_file"])
    expect(
      afterRegistration.definitions.map((definition) => definition.name),
    ).toEqual(["read_file", "calendar__list_events"])
  })

  it("validates structured names at the external registration boundary", () => {
    const registry = createToolRegistry([])
    const invalid = {
      ...tool("read"),
      toolName: { namespace: "bad__namespace", name: "read" },
    }

    expect(() => registry.registerExternal(invalid, "mcp-a")).toThrow(
      "Invalid tool namespace name",
    )
    expect(() => registry.registerExternal(tool("read"), " mcp-a")).toThrow(
      "contain no surrounding whitespace",
    )
    expect(() => namespacedToolName("a", "_b")).toThrow(
      "Invalid namespaced tool boundary",
    )
    expect(() => namespacedToolName("a_", "b")).toThrow(
      "Invalid namespaced tool boundary",
    )
  })

  it("protects trusted names and namespace ownership from external tools", () => {
    const registry = createToolRegistry([
      tool("read_file"),
      identifiedTool(namespacedToolName("github", "status")),
    ])
    expect(registry.registerExternal(tool("read_file"), "mcp-a")).toBe(false)
    expect(registry.registerExternal(tool("exec_command"), "mcp-a")).toBe(false)
    expect(
      registry.registerExternal(
        identifiedTool(namespacedToolName("github", "issues")),
        "mcp-a",
      ),
    ).toBe(false)
    expect(
      registry.registerExternal(
        identifiedTool(namespacedToolName("gitlab", "pulls")),
        "mcp-a",
      ),
    ).toBe(true)
    expect(
      registry.registerExternal(
        identifiedTool(namespacedToolName("gitlab", "issues")),
        "trusted",
      ),
    ).toBe(false)
    expect(registry.firstCollision()).toEqual(plainToolName("read_file"))
  })

  it("keeps trusted configuration and external catalogs scoped separately", () => {
    const trusted = [tool("read_file")]
    const firstSession = createToolRegistry(trusted)
    const secondSession = createToolRegistry(trusted)

    expect(
      firstSession.registerExternal(
        identifiedTool(namespacedToolName("calendar", "events")),
        "calendar-server",
      ),
    ).toBe(true)

    expect(firstSession.trustedToolNames()).toEqual(["read_file"])
    expect(secondSession.trustedToolNames()).toEqual(["read_file"])
    expect(
      finalize(
        firstSession,
        new Set(firstSession.trustedToolNames()),
      ).definitions.map((definition) => definition.name),
    ).toEqual(["read_file", "calendar__events"])
    expect(
      finalize(
        secondSession,
        new Set(secondSession.trustedToolNames()),
      ).definitions.map((definition) => definition.name),
    ).toEqual(["read_file"])
  })

  it("keeps a finalized router bound to the runtime the model saw", async () => {
    const registry = createToolRegistry([])
    const toolName = namespacedToolName("demo", "lookup")
    expect(
      registry.registerExternal(
        identifiedTool(toolName, "version one"),
        "demo",
      ),
    ).toBe(true)
    const first = finalize(registry, new Set([canonicalToolName(toolName)]))

    expect(registry.unregisterExternalSource("demo")).toBe(1)
    expect(
      registry.registerExternal(
        identifiedTool(toolName, "version two"),
        "demo",
      ),
    ).toBe(true)
    const second = finalize(registry, new Set([canonicalToolName(toolName)]))

    await expect(
      first.execute("demo__lookup", {}, { workspaceRoot: "/workspace" }),
    ).resolves.toMatchObject({ content: "version one" })
    await expect(
      second.execute("demo__lookup", {}, { workspaceRoot: "/workspace" }),
    ).resolves.toMatchObject({ content: "version two" })
    await first.release()
    await second.release()
  })

  it("replaces one external source atomically and retires old runtimes after Step release", async () => {
    const disposed: string[] = []
    const versionOne = {
      ...identifiedTool(namespacedToolName("demo", "lookup"), "version one"),
      dispose() {
        disposed.push("version one")
      },
    }
    const versionTwo = {
      ...identifiedTool(namespacedToolName("demo", "lookup"), "version two"),
      dispose() {
        disposed.push("version two")
      },
    }
    const registry = createToolRegistry([])
    expect(registry.registerExternal(versionOne, "demo")).toBe(true)
    const oldStep = finalize(registry, new Set())

    expect(registry.replaceExternalSource("demo", [versionTwo])).toEqual({
      removed: 1,
      registered: 1,
    })
    expect(disposed).toEqual([])
    await expect(
      oldStep.execute("demo__lookup", {}, { workspaceRoot: "/workspace" }),
    ).resolves.toMatchObject({ content: "version one" })

    const newStep = finalize(registry, new Set())
    await expect(
      newStep.execute("demo__lookup", {}, { workspaceRoot: "/workspace" }),
    ).resolves.toMatchObject({ content: "version two" })
    await oldStep.release()
    expect(disposed).toEqual(["version one"])
    await newStep.release()
    await registry.dispose()
    expect(disposed).toEqual(["version one", "version two"])
  })

  it("keeps a disposable runtime leased while readiness outlives its Step", async () => {
    let entered!: () => void
    let resolveReadiness!: () => void
    const readinessEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const readiness = new Promise<void>((resolve) => {
      resolveReadiness = resolve
    })
    let disposed = false
    const runtime = {
      ...identifiedTool(namespacedToolName("demo", "lookup")),
      async waitUntilReady() {
        entered()
        await readiness
      },
      dispose() {
        disposed = true
      },
    }
    const registry = createToolRegistry([])
    registry.registerExternal(runtime, "demo")
    const step = finalize(registry, new Set())
    const pendingReadiness = step.waitUntilReady("demo__lookup", {
      workspaceRoot: "/workspace",
    })
    await readinessEntered

    registry.replaceExternalSource("demo", [])
    await step.release()
    expect(disposed).toBe(false)

    resolveReadiness()
    await pendingReadiness
    expect(disposed).toBe(true)
  })

  it("does not create a runtime lease for definition-only inspection", async () => {
    let disposed = false
    const runtime = {
      ...identifiedTool(namespacedToolName("demo", "lookup")),
      dispose() {
        disposed = true
      },
    }
    const registry = createToolRegistry([])
    expect(registry.registerExternal(runtime, "demo")).toBe(true)

    expect(registry.definitions().map((definition) => definition.name)).toEqual(
      ["demo__lookup"],
    )
    expect(registry.unregisterExternalSource("demo")).toBe(1)
    await Promise.resolve()
    expect(disposed).toBe(true)
  })

  it("leaves the previous external source untouched when replacement validation fails", async () => {
    const registry = createToolRegistry([tool("read_file")])
    const previous = identifiedTool(
      namespacedToolName("demo", "lookup"),
      "previous",
    )
    expect(registry.registerExternal(previous, "demo")).toBe(true)

    expect(() =>
      registry.replaceExternalSource("demo", [
        identifiedTool(namespacedToolName("demo", "new_lookup")),
        tool("read_file"),
      ]),
    ).toThrow("conflicting tool read_file")

    const step = finalize(registry, new Set(["read_file"]))
    expect(step.get("demo__lookup")).toBeDefined()
    expect(step.get("demo__new_lookup")).toBeUndefined()
    await expect(
      step.execute("demo__lookup", {}, { workspaceRoot: "/workspace" }),
    ).resolves.toMatchObject({ content: "previous" })
    await step.release()
    await registry.dispose()
  })

  it("uses exact-name lookup and BM25 identifier/schema terms for deferred tools", async () => {
    const registry = createToolRegistry([])
    expect(
      registry.registerExternal(
        {
          ...identifiedTool(
            namespacedToolName("grafana-ai", "SearchDashboards"),
            "dashboards",
            "deferred",
          ),
          description: "Find observability views",
          inputSchema: {
            type: "object",
            properties: {
              datasourceId: {
                anyOf: [
                  {
                    type: "string",
                    description: "Prometheus data source identifier",
                  },
                ],
              },
            },
          },
        },
        "grafana",
      ),
    ).toBe(true)
    expect(
      registry.registerExternal(
        {
          ...identifiedTool(
            namespacedToolName("calendar", "search_events"),
            "events",
            "deferred",
          ),
          description: "Find meetings and calendar appointments",
        },
        "calendar",
      ),
    ).toBe(true)

    const step = finalize(registry, new Set())
    expect(step.search("grafana-ai__SearchDashboards")[0]?.name).toBe(
      "grafana-ai__SearchDashboards",
    )
    expect(step.search("search dashboards")[0]?.name).toBe(
      "grafana-ai__SearchDashboards",
    )
    expect(step.search("Prometheus datasource")[0]?.name).toBe(
      "grafana-ai__SearchDashboards",
    )
    expect(step.deferredDefinitions).toHaveLength(2)
    expect(step.deferredDefinitions.every((tool) => tool.deferLoading)).toBe(
      true,
    )
    expect(step.modelDefinitions.map((tool) => tool.name)).toEqual([
      "tool_search",
      "calendar__search_events",
      "grafana-ai__SearchDashboards",
    ])
    await step.release()
    await registry.dispose()
  })

  it("captures runtime method identity and capabilities for the finalized Step", async () => {
    const mutable = {
      ...identifiedTool(namespacedToolName("demo", "mutable"), "version one"),
      supportsParallelToolCalls: true,
    }
    const registry = createToolRegistry([])
    expect(registry.registerExternal(mutable, "demo")).toBe(true)
    const router = finalize(registry, new Set())

    Reflect.set(mutable, "supportsParallelToolCalls", false)
    Reflect.set(mutable, "execute", async () => ({
      ok: true,
      output: {},
      content: "version two",
    }))

    expect(router.supportsParallelToolCalls("demo__mutable")).toBe(true)
    await expect(
      router.execute("demo__mutable", {}, { workspaceRoot: "/workspace" }),
    ).resolves.toMatchObject({ content: "version one" })
  })

  it("owns an immutable definition snapshot for deferred custom tools", () => {
    const external = {
      ...identifiedTool(
        namespacedToolName("demo", "evaluate"),
        "evaluate",
        "deferred",
      ),
      inputSchema: {
        type: "object",
        properties: { code: { type: "string" } },
        required: ["code"],
      },
      customInputFormat: {
        type: "grammar" as const,
        syntax: "lark" as const,
        definition: "start: /.+/",
      },
      customInputFallbackKey: "code",
      search: { searchText: "alpha evaluator", source: "demo" },
    } satisfies RuntimeTool
    const registry = createToolRegistry([])
    expect(registry.registerExternal(external, "demo")).toBe(true)
    const router = finalize(registry, new Set())

    external.inputSchema.properties.code.type = "number"
    external.customInputFormat.definition = "start: /changed/"
    external.search.searchText = "beta evaluator"

    expect(router.search("evaluate")).toMatchObject([
      {
        inputSchema: { properties: { code: { type: "string" } } },
        inputFormat: { definition: "start: /.+/" },
      },
    ])
    expect(Object.isFrozen(router.search("evaluate")[0]?.inputSchema)).toBe(
      true,
    )
    expect(router.search("alpha")).toHaveLength(1)
    expect(router.search("beta")).toHaveLength(0)
  })

  it("produces durable deferred history when custom tools fall back to functions", () => {
    const external = {
      ...identifiedTool(
        namespacedToolName("demo", "evaluate"),
        "evaluate",
        "deferred",
      ),
      inputSchema: {
        type: "object",
        properties: { code: { type: "string" } },
        required: ["code"],
      },
      customInputFormat: {
        type: "grammar" as const,
        syntax: "lark" as const,
        definition: "start: /.+/",
      },
      customInputFallbackKey: "code",
      search: { searchText: "expression evaluator", source: "demo" },
    } satisfies RuntimeTool
    const registry = createToolRegistry([])
    expect(registry.registerExternal(external, "demo")).toBe(true)
    const router = registry.finalize({
      enabledTrustedTools: new Set(),
      customToolMode: "function",
      deferredTools: true,
      wireProtocol: "anthropic_deferred",
    })

    const tools = router.search("evaluate")
    expect(tools).toMatchObject([
      {
        name: "demo__evaluate",
        inputSchema: { required: ["code"] },
        deferLoading: true,
      },
    ])
    expect(tools[0]).not.toHaveProperty("kind")
    expect(tools[0]).not.toHaveProperty("inputFormat")
    expect(tools[0]).not.toHaveProperty("customInputFallbackKey")
    expect(
      isModelMessage({
        role: "tool",
        toolCallId: "search_1",
        content: JSON.stringify({ tools }),
        toolSearch: { tools },
      }),
    ).toBe(true)
  })

  it("refreshes a later Step when deferred metadata mutates in place", async () => {
    const external = {
      ...identifiedTool(
        namespacedToolName("demo", "lookup"),
        "version one",
        "deferred",
      ),
      search: { searchText: "alpha lookup", source: "demo" },
    } satisfies RuntimeTool
    const registry = createToolRegistry([])
    expect(registry.registerExternal(external, "demo")).toBe(true)
    const first = finalize(registry, new Set())

    external.description = "version two description"
    external.search.searchText = "beta lookup"
    const second = finalize(registry, new Set())

    expect(first.search("alpha")).toMatchObject([
      { name: "demo__lookup", description: "demo__lookup description" },
    ])
    expect(first.search("beta")).toHaveLength(0)
    expect(second.search("alpha")).toHaveLength(0)
    expect(second.search("beta")).toMatchObject([
      { name: "demo__lookup", description: "version two description" },
    ])
    await first.release()
    await second.release()
  })

  it("rejects custom tools without a required string fallback property", () => {
    const invalid = {
      ...identifiedTool(namespacedToolName("demo", "invalid")),
      customInputFormat: {
        type: "grammar" as const,
        syntax: "lark" as const,
        definition: "start: /.+/",
      },
      customInputFallbackKey: "code",
      inputSchema: {
        type: "object",
        properties: { code: { type: "number" } },
        required: [],
      },
    } satisfies RuntimeTool

    expect(() =>
      createToolRegistry([]).registerExternal(invalid, "demo"),
    ).toThrow("must require string property code")
  })

  it("keeps execution presentation separate from approval requirements", async () => {
    const registry = createToolRegistry()
    const router = finalize(
      registry,
      new Set(registry.definitions().map((definition) => definition.name)),
    )

    await expect(
      router.approvalRequirement(
        "read_file",
        { path: "README.md" },
        { workspaceRoot: "/workspace" },
      ),
    ).resolves.toEqual({ kind: "none" })
    await expect(
      router.approvalRequirement(
        "write_file",
        { path: "src/a.ts", content: "value" },
        { workspaceRoot: "/workspace" },
      ),
    ).resolves.toMatchObject({
      kind: "approval",
      action: "file_change",
      subject: "src/a.ts",
    })
    await expect(
      router.approvalRequirement(
        "exec_command",
        { cmd: "git status" },
        { workspaceRoot: process.cwd() },
      ),
    ).resolves.toMatchObject({
      kind: "approval",
      action: "command_execution",
      subject: "git status",
      reason: expect.stringContaining(process.cwd()),
    })

    const requirements = await Promise.all(
      router.definitions.map(async (definition) => {
        const requirement = await router.approvalRequirement(
          definition.name,
          approvalInput(definition.name),
          { workspaceRoot: process.cwd() },
        )
        return [
          definition.name,
          requirement.kind === "none" ? "none" : requirement.action,
        ] as const
      }),
    )
    expect(Object.fromEntries(requirements)).toEqual({
      read_file: "none",
      grep: "none",
      glob: "none",
      edit_file: "file_change",
      write_file: "file_change",
      apply_patch: "file_change",
      exec_command: "command_execution",
      write_stdin: "none",
      web_fetch: "none",
      web_search: "none",
      spawn_agent: "none",
      send_message: "none",
      followup_task: "none",
      wait_agent: "none",
      interrupt_agent: "none",
      list_agents: "none",
    })

    expect(
      router.describeExecution("exec_command", { cmd: "git status" }),
    ).toMatchObject({ type: "command_execution", command: "git status" })
  })

  it("lets the owning tool project its completed durable execution", () => {
    const registry = createToolRegistry([
      {
        ...tool("grep"),
        completeExecution(started, output) {
          return {
            ...started,
            type: "file_search",
            operation: "grep",
            pattern: "needle",
            lineNumbers: true,
            result: {
              path: ".",
              outputMode: "content",
              count: 1,
              truncated: false,
              timedOut: false,
              matches: [{ path: "src/a.ts", line: 4, text: String(output) }],
            },
          }
        },
      },
    ])
    const router = finalize(registry, new Set(["grep"]))

    expect(
      router.completeExecution(
        "grep",
        {
          type: "file_search",
          operation: "grep",
          pattern: "needle",
          lineNumbers: true,
        },
        "matched",
        true,
      ),
    ).toMatchObject({
      result: {
        matches: [{ path: "src/a.ts", line: 4, text: "matched" }],
      },
    })
  })
})

function tool(name: string): RuntimeTool {
  return identifiedTool(plainToolName(name), name)
}

function finalize(
  registry: ReturnType<typeof createToolRegistry>,
  enabledTrustedTools: ReadonlySet<string>,
) {
  return registry.finalize({
    enabledTrustedTools,
    customToolMode: "native",
    deferredTools: true,
    wireProtocol: "openai_deferred",
  })
}

function identifiedTool(
  toolName: ToolName,
  content = canonicalToolName(toolName),
  exposure: ToolExposure = "direct",
): RuntimeTool {
  return {
    toolName,
    exposure,
    description: `${canonicalToolName(toolName)} description`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    approvalRequirement: { kind: "none" },
    effect: "observe",
    async execute() {
      return {
        ok: true,
        output: { name: canonicalToolName(toolName) },
        content,
      }
    },
  }
}

function approvalInput(name: string) {
  if (name === "exec_command") return { cmd: "git status" }
  if (name === "write_file") return { path: "a.txt", content: "value" }
  if (name === "edit_file") {
    return { path: "a.txt", oldString: "old", newString: "new" }
  }
  return {}
}
