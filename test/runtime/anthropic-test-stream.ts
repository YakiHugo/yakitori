import { onTestFinished } from "vitest"
import {
  type AnthropicProviderOptions,
  createAnthropicTurnTransport,
} from "../../src/runtime/anthropic-provider.ts"

// Each fixture stream represents one Turn and owns the same asset cleanup as
// production, including when its assertions or provider request fail.
export function createAnthropicTestStream(options: AnthropicProviderOptions) {
  const transport = createAnthropicTurnTransport(options)
  onTestFinished(() => transport.close())
  return transport.stream
}
