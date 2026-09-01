import type { JsonValue, ToolExecutionDescriptor } from "../../kernel/index.ts"
import type { ModelToolDefinition, ToolWireProtocol } from "../model.ts"
import type { UserShellEnv } from "../user-shell-env.ts"
import { createApplyPatchTool } from "./apply-patch.ts"
import { createEditFileTool } from "./edit-file.ts"
import { dynamicToolExecution } from "./execution-descriptors.ts"
import { createGlobTool } from "./glob.ts"
import { createGrepTool } from "./grep.ts"
import { createMultiAgentTools } from "./multi-agent.ts"
import { createReadFileTool } from "./read-file.ts"
import {
  canonicalToolName,
  namespacedToolName,
  plainToolName,
  type ToolName,
} from "./tool-name.ts"
import {
  createToolSearchIndex,
  type ToolSearchIndex,
} from "./tool-search-index.ts"
import type {
  RuntimeTool,
  ToolApprovalRequirement,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolExposure,
} from "./types.ts"
import { createUnifiedExecTools } from "./unified-exec.ts"
import { createWebFetchTool } from "./web-fetch.ts"
import { createWebSearchTool } from "./web-search.ts"
import { createWriteFileTool } from "./write-file.ts"

export type ToolSource =
  | Readonly<{ kind: "trusted" }>
  | Readonly<{ kind: "external"; sourceId: string }>

type RegisteredTool = Readonly<{
  runtime: RuntimeTool
  source: ToolSource
  exposure: ToolExposure
}>

type Retirement = {
  started: boolean
  readonly promise: Promise<void>
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
}

const TOOL_SEARCH_NAME = "tool_search"
const USE_TOOL_NAME = "use_tool"
const DEFAULT_TOOL_SEARCH_LIMIT = 8
const RESERVED_EXTERNAL_DEFAULT_NAMES = new Set([
  "exec_command",
  "write_stdin",
  "apply_patch",
  TOOL_SEARCH_NAME,
  USE_TOOL_NAME,
])

export type ToolFinalizeOptions = Readonly<{
  enabledTrustedTools: ReadonlySet<string>
  customToolMode: "function" | "native"
  wireProtocol: ToolWireProtocol
}>

export type ToolRouter = Readonly<{
  definitions: ReadonlyArray<ModelToolDefinition>
  deferredDefinitions: ReadonlyArray<ModelToolDefinition>
  modelDefinitions: ReadonlyArray<ModelToolDefinition>
  resolveInvocation(
    name: string,
    input: JsonValue,
  ): Readonly<{ name: string; input: JsonValue }>
  get(name: string): RuntimeTool | undefined
  source(name: string): ToolSource | undefined
  exposure(name: string): ToolExposure | undefined
  supportsParallelToolCalls(name: string): boolean
  search(query: string, limit?: number): ReadonlyArray<ModelToolDefinition>
  describeExecution(name: string, input: JsonValue): ToolExecutionDescriptor
  completeExecution(
    name: string,
    started: ToolExecutionDescriptor,
    output: JsonValue,
    succeeded: boolean,
  ): ToolExecutionDescriptor
  approvalRequirement(
    name: string,
    input: unknown,
    context: Readonly<{ workspaceRoot: string }>,
  ): Promise<ToolApprovalRequirement>
  waitUntilReady(
    name: string,
    context: Readonly<{ workspaceRoot: string; signal?: AbortSignal }>,
  ): Promise<void>
  execute(
    name: string,
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>
  release(): Promise<void>
}>

export type ToolRegistry = Readonly<{
  trustedToolNames(): ReadonlyArray<string>
  definitions(): ReadonlyArray<ModelToolDefinition>
  registerExternal(tool: RuntimeTool, sourceId: string): boolean
  unregisterExternalSource(sourceId: string): number
  replaceExternalSource(
    sourceId: string,
    tools: ReadonlyArray<RuntimeTool>,
  ): Readonly<{ removed: number; registered: number }>
  firstCollision(): ToolName | undefined
  finalize(options: ToolFinalizeOptions): ToolRouter
  dispose(): Promise<void>
}>

export function createToolRegistry(
  trustedTools: ReadonlyArray<RuntimeTool> = createDefaultTools(),
): ToolRegistry {
  let registered = new Map<string, RegisteredTool>()
  const trustedToolNames: string[] = []
  let namespaceOwners = new Map<string, string>()
  let firstCollision: ToolName | undefined
  let catalogGeneration = 0
  const searchCache = new Map<
    string,
    Readonly<{
      generation: number
      fingerprint: string
      index: ToolSearchIndex
      definitions: ReadonlyArray<ModelToolDefinition>
    }>
  >()
  const runtimeLeases = new Map<RuntimeTool, number>()
  const retirements = new Map<RuntimeTool, Retirement>()

  for (const tool of trustedTools) {
    validateCustomTool(tool)
    const canonicalName = canonicalToolName(tool.toolName)
    if (canonicalName === TOOL_SEARCH_NAME) {
      throw new Error(`Reserved trusted tool name: ${TOOL_SEARCH_NAME}`)
    }
    if (registered.has(canonicalName)) {
      throw new Error(`Duplicate trusted tool name: ${canonicalName}`)
    }
    claimTrustedNamespace(tool.toolName, namespaceOwners)
    registered.set(canonicalName, {
      runtime: tool,
      source: { kind: "trusted" },
      exposure: tool.exposure ?? "direct",
    })
    trustedToolNames.push(canonicalName)
  }

  const registry: ToolRegistry = {
    trustedToolNames() {
      return [...trustedToolNames]
    },
    definitions() {
      const definitions = [...registered.values()]
        .filter((entry) => entry.exposure === "direct")
        .map((entry) =>
          modelVisibleDefinition(snapshotDefinition(entry.runtime)),
        )
      if (
        [...registered.values()].some((entry) => entry.exposure === "deferred")
      ) {
        definitions.push(
          modelVisibleDefinition(
            snapshotDefinition(createToolSearchTool(() => [])),
          ),
        )
      }
      return definitions
    },
    registerExternal(tool, sourceId) {
      validateSourceId(sourceId)
      validateCustomTool(tool)
      if (retirements.has(tool)) {
        throw new Error("Cannot register a retired external tool runtime.")
      }
      const canonicalName = canonicalToolName(tool.toolName)
      if (
        (tool.toolName.namespace === undefined &&
          RESERVED_EXTERNAL_DEFAULT_NAMES.has(tool.toolName.name)) ||
        registered.has(canonicalName) ||
        !claimExternalNamespace(
          tool.toolName,
          externalOwner(sourceId),
          namespaceOwners,
        )
      ) {
        firstCollision ??= { ...tool.toolName }
        return false
      }
      registered.set(canonicalName, {
        runtime: tool,
        source: { kind: "external", sourceId },
        exposure: tool.exposure ?? "direct",
      })
      catalogGeneration += 1
      searchCache.clear()
      return true
    },
    unregisterExternalSource(sourceId) {
      return registry.replaceExternalSource(sourceId, []).removed
    },
    replaceExternalSource(sourceId, tools) {
      validateSourceId(sourceId)
      const previousEntries = [...registered.values()].filter(
        (entry) =>
          entry.source.kind === "external" &&
          entry.source.sourceId === sourceId,
      )
      const staged = new Map(
        [...registered].filter(
          ([, entry]) =>
            entry.source.kind !== "external" ||
            entry.source.sourceId !== sourceId,
        ),
      )
      const stagedNamespaceOwners = rebuildNamespaceOwners(staged)
      for (const tool of tools) {
        validateCustomTool(tool)
        if (retirements.has(tool)) {
          throw new Error("Cannot register a retired external tool runtime.")
        }
        const canonicalName = canonicalToolName(tool.toolName)
        if (
          (tool.toolName.namespace === undefined &&
            RESERVED_EXTERNAL_DEFAULT_NAMES.has(tool.toolName.name)) ||
          staged.has(canonicalName) ||
          !claimExternalNamespace(
            tool.toolName,
            externalOwner(sourceId),
            stagedNamespaceOwners,
          )
        ) {
          firstCollision ??= { ...tool.toolName }
          throw new Error(
            `External source ${sourceId} contains conflicting tool ${canonicalName}.`,
          )
        }
        staged.set(canonicalName, {
          runtime: tool,
          source: { kind: "external", sourceId },
          exposure: tool.exposure ?? "direct",
        })
      }

      registered = staged
      namespaceOwners = stagedNamespaceOwners
      catalogGeneration += 1
      searchCache.clear()
      retireUnregisteredRuntimes(
        previousEntries.map((entry) => entry.runtime),
        registered,
        runtimeLeases,
        retirements,
      )
      return { removed: previousEntries.length, registered: tools.length }
    },
    firstCollision() {
      return firstCollision === undefined ? undefined : { ...firstCollision }
    },
    async dispose() {
      retireUnregisteredRuntimes(
        [...registered.values()].map((entry) => entry.runtime),
        new Map(),
        runtimeLeases,
        retirements,
      )
      registered = new Map()
      namespaceOwners = new Map()
      await Promise.all([...retirements.values()].map((state) => state.promise))
    },
    finalize(options) {
      const eligible = [...registered.entries()].filter(
        ([name, entry]) =>
          entry.source.kind === "external" ||
          options.enabledTrustedTools.has(name),
      )
      const selected = new Map([
        ...eligible.filter(([, entry]) => entry.source.kind === "trusted"),
        ...eligible
          .filter(([, entry]) => entry.source.kind === "external")
          .sort(([left], [right]) => left.localeCompare(right)),
      ])
      const deferred = [...selected.values()].filter(
        (entry) => entry.exposure === "deferred",
      )
      const selectionKey = JSON.stringify({
        customToolMode: options.customToolMode,
        enabledTrustedTools: [...options.enabledTrustedTools].sort(),
      })
      // External runtimes may refresh their definition/search metadata in
      // place. Re-snapshot on every Step so the search cache represents the
      // exact catalog captured by that Step, not merely the registration set.
      const deferredDocuments = deferred.map((entry) => ({
        definition: deepFreeze({
          ...definitionForMode(
            snapshotDefinition(entry.runtime),
            options.customToolMode,
          ),
          deferLoading: true,
        }),
        search:
          entry.runtime.search === undefined
            ? undefined
            : deepFreeze(structuredClone(entry.runtime.search)),
      }))
      const searchFingerprint = JSON.stringify(deferredDocuments)
      let cachedSearch = searchCache.get(selectionKey)
      if (
        cachedSearch === undefined ||
        cachedSearch.generation !== catalogGeneration ||
        cachedSearch.fingerprint !== searchFingerprint
      ) {
        const definitions = deferredDocuments.map(
          ({ definition }) => definition,
        )
        cachedSearch = {
          generation: catalogGeneration,
          fingerprint: searchFingerprint,
          definitions,
          index: createToolSearchIndex(
            deferredDocuments.map(({ definition, search }) => ({
              definition,
              ...(search === undefined ? {} : { metadata: search }),
            })),
          ),
        }
        searchCache.set(selectionKey, cachedSearch)
      }
      const stepSearch = cachedSearch
      const search = (query: string, limit = DEFAULT_TOOL_SEARCH_LIMIT) => {
        validateToolSearchLimit(limit)
        return stepSearch.index.search(query, limit)
      }

      if (deferred.length > 0) {
        const toolSearch = createToolSearchTool(search)
        selected.set(TOOL_SEARCH_NAME, {
          runtime: toolSearch,
          source: { kind: "trusted" },
          exposure: "direct",
        })
      }

      if (deferred.length > 0 && options.wireProtocol === "meta_dispatch") {
        selected.set(USE_TOOL_NAME, {
          runtime: createUseTool(selected),
          source: { kind: "trusted" },
          exposure: "direct",
        })
      }

      // A Router is the immutable identity/spec/runtime snapshot for one model
      // Step. Later catalog refreshes only affect a newly finalized Router.
      const snapshot = new Map(
        [...selected].map(([name, entry]) => [
          name,
          { ...entry, runtime: snapshotRuntime(entry.runtime) },
        ]),
      )
      const definitionSnapshot = new Map(
        [...snapshot].map(([name, entry]) => [
          name,
          definitionForMode(
            snapshotDefinition(entry.runtime),
            options.customToolMode,
          ),
        ]),
      )
      const definitions = [...snapshot.values()]
        .filter((entry) => entry.exposure === "direct")
        .map((entry) =>
          modelVisibleDefinition(
            requireDefinition(
              definitionSnapshot,
              canonicalToolName(entry.runtime.toolName),
            ),
          ),
        )
      const deferredDefinitions = stepSearch.definitions
      const leasedRuntimes = new Set(
        [...selected.values()]
          .filter(
            (entry) =>
              canonicalToolName(entry.runtime.toolName) !== TOOL_SEARCH_NAME,
          )
          .map((entry) => entry.runtime),
      )
      for (const runtime of leasedRuntimes) {
        runtimeLeases.set(runtime, (runtimeLeases.get(runtime) ?? 0) + 1)
      }
      let released = false
      return {
        definitions,
        deferredDefinitions,
        modelDefinitions:
          options.wireProtocol === "meta_dispatch"
            ? definitions
            : [...definitions, ...deferredDefinitions],
        resolveInvocation(name, input) {
          if (name !== USE_TOOL_NAME) return { name, input }
          const target = metaDispatchInput(input)
          if (
            target === undefined ||
            snapshot.get(target.name)?.exposure !== "deferred"
          ) {
            return { name, input }
          }
          return target
        },
        get(name) {
          return snapshot.get(name)?.runtime
        },
        source(name) {
          const source = snapshot.get(name)?.source
          return source === undefined ? undefined : { ...source }
        },
        exposure(name) {
          return snapshot.get(name)?.exposure
        },
        supportsParallelToolCalls(name) {
          const entry = snapshot.get(name)
          return (
            entry?.exposure !== "hidden" &&
            entry?.runtime.supportsParallelToolCalls === true
          )
        },
        search,
        describeExecution(name, input) {
          return (
            snapshot.get(name)?.runtime.describeExecution?.(input) ??
            dynamicToolExecution()
          )
        },
        completeExecution(name, started, output, succeeded) {
          return (
            snapshot
              .get(name)
              ?.runtime.completeExecution?.(started, output, succeeded) ??
            started
          )
        },
        async approvalRequirement(name, input, context) {
          const tool = snapshot.get(name)?.runtime
          if (tool === undefined) return { kind: "none" }
          return typeof tool.approvalRequirement === "function"
            ? tool.approvalRequirement(input, context)
            : tool.approvalRequirement
        },
        async waitUntilReady(name, context) {
          const tool = snapshot.get(name)?.runtime
          if (tool === undefined) return
          const ownedRuntime = selected.get(name)?.runtime
          if (
            tool.waitUntilReady === undefined ||
            ownedRuntime === undefined ||
            ownedRuntime.dispose === undefined
          ) {
            await tool.waitUntilReady?.(context)
            return
          }
          runtimeLeases.set(
            ownedRuntime,
            (runtimeLeases.get(ownedRuntime) ?? 0) + 1,
          )
          try {
            await tool.waitUntilReady(context)
          } finally {
            await releaseRuntimeLease(ownedRuntime, runtimeLeases, retirements)
          }
        },
        async execute(name, input, context) {
          const tool = snapshot.get(name)?.runtime
          if (tool === undefined) {
            const message = `Unknown or disabled tool: ${name}`
            return {
              ok: false,
              code: "unknown_tool",
              message,
              content: message,
            }
          }
          return tool.execute(input, context)
        },
        async release() {
          if (released) return
          released = true
          const disposals: Promise<void>[] = []
          for (const runtime of leasedRuntimes) {
            const disposal = releaseRuntimeLease(
              runtime,
              runtimeLeases,
              retirements,
            )
            if (disposal !== undefined) disposals.push(disposal)
          }
          await Promise.all(disposals)
        },
      }
    },
  }
  return registry
}

function claimTrustedNamespace(
  toolName: ToolName,
  namespaceOwners: Map<string, string>,
): void {
  if (toolName.namespace === undefined) return
  const existing = namespaceOwners.get(toolName.namespace)
  if (existing !== undefined && existing !== "trusted") {
    throw new Error(
      `Trusted tool namespace ${toolName.namespace} is already owned by ${existing}.`,
    )
  }
  namespaceOwners.set(toolName.namespace, "trusted")
}

function claimExternalNamespace(
  toolName: ToolName,
  owner: string,
  namespaceOwners: Map<string, string>,
): boolean {
  if (toolName.namespace === undefined) return true
  const existing = namespaceOwners.get(toolName.namespace)
  if (existing === undefined) {
    namespaceOwners.set(toolName.namespace, owner)
    return true
  }
  return existing === owner
}

function validateSourceId(sourceId: string): void {
  if (sourceId.trim().length === 0 || sourceId !== sourceId.trim()) {
    throw new Error(
      "External tool sourceId must be non-empty and contain no surrounding whitespace.",
    )
  }
}

function externalOwner(sourceId: string): string {
  return `external:${sourceId}`
}

function rebuildNamespaceOwners(
  registered: ReadonlyMap<string, RegisteredTool>,
): Map<string, string> {
  const owners = new Map<string, string>()
  for (const entry of registered.values()) {
    if (entry.source.kind === "trusted") {
      claimTrustedNamespace(entry.runtime.toolName, owners)
      continue
    }
    if (
      !claimExternalNamespace(
        entry.runtime.toolName,
        externalOwner(entry.source.sourceId),
        owners,
      )
    ) {
      throw new Error("Registered external namespace ownership is invalid.")
    }
  }
  return owners
}

function retireUnregisteredRuntimes(
  candidates: Iterable<RuntimeTool>,
  registered: ReadonlyMap<string, RegisteredTool>,
  leases: ReadonlyMap<RuntimeTool, number>,
  retirements: Map<RuntimeTool, Retirement>,
): void {
  const live = new Set([...registered.values()].map((entry) => entry.runtime))
  for (const runtime of new Set(candidates)) {
    if (live.has(runtime) || retirements.has(runtime)) continue
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const promise = new Promise<void>((accepted, rejected) => {
      resolve = accepted
      reject = rejected
    })
    // The registry owns observation of retirement errors. Attaching a handler
    // prevents a rejection from becoming unhandled before dispose()/release().
    void promise.catch(() => undefined)
    const retirement = { started: false, promise, resolve, reject }
    retirements.set(runtime, retirement)
    if ((leases.get(runtime) ?? 0) === 0) {
      startRetirement(runtime, retirement)
    }
  }
}

function startRetirement(runtime: RuntimeTool, retirement: Retirement): void {
  if (retirement.started) return
  retirement.started = true
  Promise.resolve()
    .then(() => runtime.dispose?.())
    .then(retirement.resolve, retirement.reject)
}

function releaseRuntimeLease(
  runtime: RuntimeTool,
  leases: Map<RuntimeTool, number>,
  retirements: Map<RuntimeTool, Retirement>,
): Promise<void> | undefined {
  const remaining = (leases.get(runtime) ?? 1) - 1
  if (remaining === 0) leases.delete(runtime)
  else leases.set(runtime, remaining)
  const retirement = retirements.get(runtime)
  if (retirement === undefined || remaining !== 0) return undefined
  startRetirement(runtime, retirement)
  return retirement.promise
}

function createToolSearchTool(
  search: (query: string, limit?: number) => ReadonlyArray<ModelToolDefinition>,
): RuntimeTool {
  return {
    toolName: plainToolName(TOOL_SEARCH_NAME),
    description:
      "Search deferred tools by capability. The result includes callable tool names, descriptions, and input schemas.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1 },
        limit: {
          type: "integer",
          minimum: 1,
        },
      },
      required: ["query"],
    },
    effect: "observe",
    supportsParallelToolCalls: true,
    approvalRequirement: { kind: "none" },
    async execute(input) {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return invalidToolSearchInput("input must be an object")
      }
      const query = Reflect.get(input, "query")
      const rawLimit = Reflect.get(input, "limit")
      if (typeof query !== "string" || query.trim().length === 0) {
        return invalidToolSearchInput("query must be a non-empty string")
      }
      if (
        rawLimit !== undefined &&
        (!Number.isInteger(rawLimit) || (rawLimit as number) < 1)
      ) {
        return invalidToolSearchInput("limit must be a positive integer")
      }
      const tools = search(query, rawLimit as number | undefined)
      return {
        ok: true,
        output: { tools },
        content: JSON.stringify({ tools }),
      }
    },
  }
}

function invalidToolSearchInput(message: string): ToolExecutionResult {
  return {
    ok: false,
    code: "invalid_tool_input",
    message,
    content: message,
  }
}

function validateToolSearchLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Tool search limit must be a positive integer.")
  }
}

function modelVisibleDefinition(
  definition: ModelToolDefinition,
): ModelToolDefinition {
  return definition.name === TOOL_SEARCH_NAME
    ? deepFreeze({ ...definition, kind: "tool_search" as const })
    : definition
}

function definitionForMode(
  definition: ModelToolDefinition,
  mode: ToolFinalizeOptions["customToolMode"],
): ModelToolDefinition {
  if (mode === "native" || definition.kind !== "custom") return definition
  const {
    kind: _kind,
    inputFormat: _inputFormat,
    customInputFallbackKey: _customInputFallbackKey,
    ...fallback
  } = definition
  return deepFreeze(fallback)
}

function createUseTool(
  selected: ReadonlyMap<string, RegisteredTool>,
): RuntimeTool {
  return {
    toolName: plainToolName(USE_TOOL_NAME),
    description:
      "Call a deferred integration tool. Use tool_search first, then pass the discovered tool name and an input object matching its schema.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        tool_name: { type: "string", minLength: 1 },
        tool_input: { type: "object", additionalProperties: true },
      },
      required: ["tool_name", "tool_input"],
    },
    effect: "opaque",
    approvalRequirement: { kind: "none" },
    async execute(input) {
      const target = metaDispatchInput(input)
      const message =
        target === undefined
          ? "use_tool requires a tool_name and object tool_input."
          : selected.get(target.name)?.exposure !== "deferred"
            ? `Unknown or non-deferred tool: ${target.name}`
            : "use_tool dispatch was not resolved by the Step router."
      return {
        ok: false,
        code: "invalid_tool_input",
        message,
        content: message,
      }
    },
  }
}

function metaDispatchInput(
  input: unknown,
): Readonly<{ name: string; input: JsonValue }> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined
  }
  const name = Reflect.get(input, "tool_name")
  const toolInput = Reflect.get(input, "tool_input")
  if (
    typeof name !== "string" ||
    name.trim().length === 0 ||
    typeof toolInput !== "object" ||
    toolInput === null ||
    Array.isArray(toolInput)
  ) {
    return undefined
  }
  return { name, input: toolInput as JsonValue }
}

function toDefinition(tool: RuntimeTool): ModelToolDefinition {
  return {
    name: canonicalToolName(tool.toolName),
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.customInputFormat === undefined
      ? {}
      : {
          kind: "custom" as const,
          inputFormat: tool.customInputFormat,
          customInputFallbackKey: tool.customInputFallbackKey,
        }),
  }
}

function validateCustomTool(tool: RuntimeTool): void {
  if (tool.customInputFormat === undefined) return
  const key = tool.customInputFallbackKey
  if (key === undefined || key.trim().length === 0 || key !== key.trim()) {
    throw new Error(
      `Custom tool ${canonicalToolName(tool.toolName)} requires a customInputFallbackKey.`,
    )
  }
  const properties = tool.inputSchema.properties
  const fallbackProperty =
    typeof properties === "object" &&
    properties !== null &&
    !Array.isArray(properties)
      ? Reflect.get(properties, key)
      : undefined
  if (
    typeof fallbackProperty !== "object" ||
    fallbackProperty === null ||
    Array.isArray(fallbackProperty) ||
    fallbackProperty.type !== "string" ||
    !Array.isArray(tool.inputSchema.required) ||
    !tool.inputSchema.required.includes(key)
  ) {
    throw new Error(
      `Custom tool ${canonicalToolName(tool.toolName)} fallback schema must require string property ${key}.`,
    )
  }
}

function snapshotDefinition(tool: RuntimeTool): ModelToolDefinition {
  return deepFreeze(structuredClone(toDefinition(tool)))
}

function snapshotRuntime(tool: RuntimeTool): RuntimeTool {
  const approvalRequirement =
    typeof tool.approvalRequirement === "function"
      ? tool.approvalRequirement.bind(tool)
      : deepFreeze(structuredClone(tool.approvalRequirement))
  const describeExecution = tool.describeExecution?.bind(tool)
  const completeExecution = tool.completeExecution?.bind(tool)
  const waitUntilReady = tool.waitUntilReady?.bind(tool)
  const execute = tool.execute.bind(tool)
  return Object.freeze({
    toolName: deepFreeze(structuredClone(tool.toolName)),
    ...(tool.exposure === undefined ? {} : { exposure: tool.exposure }),
    ...(tool.search === undefined
      ? {}
      : { search: deepFreeze(structuredClone(tool.search)) }),
    ...(tool.supportsParallelToolCalls === undefined
      ? {}
      : { supportsParallelToolCalls: tool.supportsParallelToolCalls }),
    description: tool.description,
    inputSchema: deepFreeze(structuredClone(tool.inputSchema)),
    ...(tool.customInputFormat === undefined
      ? {}
      : {
          customInputFormat: deepFreeze(
            structuredClone(tool.customInputFormat),
          ),
        }),
    ...(tool.customInputFallbackKey === undefined
      ? {}
      : { customInputFallbackKey: tool.customInputFallbackKey }),
    effect: tool.effect,
    approvalRequirement,
    ...(describeExecution === undefined ? {} : { describeExecution }),
    ...(completeExecution === undefined ? {} : { completeExecution }),
    ...(waitUntilReady === undefined ? {} : { waitUntilReady }),
    execute,
  })
}

function requireDefinition(
  definitions: ReadonlyMap<string, ModelToolDefinition>,
  name: string,
): ModelToolDefinition {
  const definition = definitions.get(name)
  if (definition === undefined) {
    throw new Error(`Missing finalized tool definition: ${name}`)
  }
  return definition
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value
  }
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

export function createDefaultTools(
  input: {
    readonly userShellEnv?: UserShellEnv
    readonly execCommandLog?: (message: string) => void
  } = {},
): ReadonlyArray<RuntimeTool> {
  return [
    createReadFileTool(),
    createGrepTool(),
    createGlobTool(),
    createEditFileTool(),
    createWriteFileTool(),
    createApplyPatchTool(),
    ...createUnifiedExecTools({
      ...(input.userShellEnv === undefined
        ? {}
        : { userShellEnv: input.userShellEnv }),
      ...(input.execCommandLog === undefined
        ? {}
        : { log: input.execCommandLog }),
    }),
    createWebFetchTool(),
    createWebSearchTool(),
    ...createMultiAgentTools(),
  ]
}

export type { ToolName } from "./tool-name.ts"
export type {
  RuntimeTool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types.ts"
export { canonicalToolName, namespacedToolName, plainToolName }
