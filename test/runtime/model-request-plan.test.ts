import { describe, expect, it } from "vitest"
import type { ModelRequest } from "../../src/runtime/model.ts"
import type { ResolvedModel } from "../../src/runtime/model-catalog.ts"
import { prepareModelRequestPlan } from "../../src/runtime/model-request-plan.ts"

const model: ResolvedModel = {
  provider: "account",
  model: "example",
  instructionProfileId: "default",
  inputModalities: ["text", "image"],
  imageDetailModes: ["high"],
  shellToolType: "disabled",
  fileEditingToolType: "edit_write",
  supportsNativeToolSearch: true,
  supportsCustomTools: true,
  usedFallbackModelMetadata: false,
  efforts: ["low", "high"],
  defaultEffort: "high",
  speeds: ["fast"],
  defaultOutputTokens: 128,
  maxOutputTokens: 512,
}

const request: ModelRequest = {
  target: {
    provider: "account",
    model: "example",
    instructionProfileId: "generic",
  },
  messages: [
    { role: "user", content: [{ type: "text", text: "Inspect this" }] },
  ],
  system: [],
  tools: [],
  toolWireProtocol: "eager",
}

describe("logical model request planning", () => {
  it("captures defaults and request controls before physical retries", () => {
    const tool = {
      name: "inspect",
      description: "Original tool",
      inputSchema: { type: "object" },
    }
    const tools = [tool]
    const systemSection = {
      id: "base",
      revision: "one",
      text: "Original system",
    }
    const system = [systemSection]
    const providerOptions = {
      provider: "account",
      wireApi: "openai_responses" as const,
      body: { reasoning: { summary: "auto" } },
    }
    const toolChoice = { name: "inspect" }
    const planned = prepareModelRequestPlan(
      { ...request, tools, system, providerOptions, toolChoice },
      { model, wireApi: "openai_responses" },
    )
    tool.description = "Changed tool"
    systemSection.text = "Changed system"
    providerOptions.body.reasoning.summary = "Changed control"
    toolChoice.name = "Changed choice"

    expect(planned.request).toMatchObject({
      target: { effort: "high" },
      maxOutputTokens: 128,
      reasoning: { efforts: ["low", "high"], defaultEffort: "high" },
      tools: [{ description: "Original tool" }],
      toolChoice: { name: "inspect" },
      system: [{ text: "Original system" }],
      providerOptions: { body: { reasoning: { summary: "auto" } } },
    })
    expect(planned.budget.outputReserveTokens).toBe(128)
  })

  it("keeps explicit choices and reports estimated overflow to the compaction owner", () => {
    const planned = prepareModelRequestPlan(
      {
        ...request,
        target: { ...request.target, effort: "low", speed: "fast" },
        maxOutputTokens: 256,
      },
      { model, wireApi: "openai_responses", inputLimitTokens: 1 },
    )
    expect(planned.request.target.effort).toBe("low")
    expect(planned.request.target.speed).toBe("fast")
    expect(planned.request.maxOutputTokens).toBe(256)
    expect(planned.inputBudgetExceeded).toBe(true)
    expect(planned.request.messages).toEqual(request.messages)
  })

  it.each([
    {
      change: { target: { ...request.target, speed: "turbo" } },
      code: "unsupported_speed",
    },
    {
      change: { target: { ...request.target, effort: "max" } },
      code: "unsupported_effort",
    },
    { change: { maxOutputTokens: 513 }, code: "budget_exceeded" },
    { change: { maxOutputTokens: 0 }, code: "invalid_request" },
    { change: { toolChoice: { name: "missing" } }, code: "invalid_request" },
  ])("rejects a captured request that violates $code", ({ change, code }) => {
    expect(() =>
      prepareModelRequestPlan(
        { ...request, ...change },
        {
          model,
          wireApi: "openai_responses",
        },
      ),
    ).toThrowError(expect.objectContaining({ code }))
  })

  it("requires native deferred support from the actual endpoint as well as the model", () => {
    const native: ModelRequest = {
      ...request,
      toolWireProtocol: "openai_deferred",
      tools: [
        {
          name: "tool_search",
          description: "Find tools",
          inputSchema: {},
          kind: "tool_search",
        },
        {
          name: "inspect",
          description: "Inspect",
          inputSchema: {},
          deferLoading: true,
        },
      ],
    }
    expect(() =>
      prepareModelRequestPlan(native, {
        model,
        wireApi: "openai_responses",
        toolCapabilities: { supportsCustomTools: false },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "unsupported_tool_protocol" }),
    )
    expect(
      prepareModelRequestPlan(native, {
        model,
        wireApi: "openai_responses",
        toolCapabilities: {
          supportsCustomTools: true,
          nativeDeferredProtocol: "openai_deferred",
        },
      }).request.toolWireProtocol,
    ).toBe("openai_deferred")
    for (const wireApi of ["unknown", "faux"] as const)
      expect(
        prepareModelRequestPlan(native, { model, wireApi }).request
          .toolWireProtocol,
      ).toBe("openai_deferred")
    expect(() =>
      prepareModelRequestPlan(native, {
        model,
        wireApi: "openai_chat_completions",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "unsupported_tool_protocol" }),
    )
  })
})
