import type { ModelRequest, ModelUsage, StreamFn } from "./model.ts"

// Preparation is a distinct physical request, never conversation history or a
// tool execution source. Observe usage even when its result becomes stale.
export async function consumeModelWarmup(
  input: Readonly<{
    stream: StreamFn
    request: ModelRequest
    onUsage(usage: ModelUsage): void | Promise<void>
  }>,
): Promise<void> {
  let usage: ModelUsage | undefined
  try {
    for await (const event of input.stream({
      ...input.request,
      streamOutputItems: false,
      onUsageSnapshot(snapshot) {
        usage = snapshot
      },
    })) {
      if (event.type === "response") {
        usage = event.response.usage ?? usage
        if (event.response.content.length !== 0)
          throw new Error(
            "Request warmup must not produce conversation content.",
          )
      } else if (event.type === "failure" || event.type === "cancelled") {
        usage = event.usage ?? usage
      } else {
        throw new Error("Request warmup must not produce output or retries.")
      }
    }
  } finally {
    if (usage !== undefined) await input.onUsage(usage)
  }
}
