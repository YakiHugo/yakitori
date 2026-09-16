// Turn-driven state settles in ~100ms locally but can take seconds on CI,
// where every test worker shares a handful of cores. The budget is a safety
// bound for genuinely stuck state, sized ~10x above the slowest turn
// observed on CI (~1s); vite.config.ts applies the same value to
// expect.poll.timeout and scales testTimeout above it.
const timeoutMs = 10_000

export async function waitForValue<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for a value.")
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
