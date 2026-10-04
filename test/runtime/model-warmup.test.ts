import { expect, it } from "vitest"
import { consumeModelWarmup } from "../../src/runtime/model-warmup.ts"
import {
  ModelStopReason,
  type ModelRequest,
  type ModelUsage,
} from "../../src/runtime/model.ts"
const request: ModelRequest = {
  target: { provider: "openai", model: "test", instructionProfileId: "test" },
  system: [],
  messages: [],
  tools: [],
  toolWireProtocol: "eager",
}
it("accounts one reported warmup sample without adding it to conversation output", async () => {
  const usage: ModelUsage[] = []
  await consumeModelWarmup({
    request,
    stream: async function* (request) {
      request.onUsageSnapshot?.({ inputTokens: 100, cacheReadInputTokens: 80 })
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [],
          usage: { inputTokens: 100, cacheReadInputTokens: 80 },
        },
      }
    },
    onUsage(sample) {
      usage.push(sample)
    },
  })
  expect(usage).toEqual([{ inputTokens: 100, cacheReadInputTokens: 80 }])
})
it("retains observed usage if stale warmup is cancelled before its terminal event", async () => {
  const usage: ModelUsage[] = []
  await consumeModelWarmup({
    request,
    stream: async function* (request) {
      request.onUsageSnapshot?.({ inputTokens: 100, cacheWriteInputTokens: 20 })
      yield { type: "cancelled" }
    },
    onUsage(sample) {
      usage.push(sample)
    },
  })
  expect(usage).toEqual([{ inputTokens: 100, cacheWriteInputTokens: 20 }])
})
