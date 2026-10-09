import { expect, it } from "vitest"
import { createRequestId, isRequestId } from "../../src/protocol/request-id.ts"

it("creates unique RPC request IDs with the existing wire prefix", () => {
  const first = createRequestId()
  expect(first).toMatch(
    /^request_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  )
  expect(createRequestId()).not.toBe(first)
})

it("accepts bounded RPC request keys without allowing path or control characters", () => {
  for (const value of ["a", "Client.request:1-2_3", "a".repeat(128)])
    expect(isRequestId(value)).toBe(true)
  for (const value of ["", "_start", "a".repeat(129), "a/b", "a\n", "a b"])
    expect(isRequestId(value)).toBe(false)
})
