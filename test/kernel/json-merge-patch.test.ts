import { describe, expect, it } from "vitest"
import {
  applyJsonMergePatch,
  createJsonMergePatch,
} from "../../src/kernel/json-equality.ts"

describe("JSON merge patches", () => {
  it.each([
    ["empty prototype-named field", {}, JSON.parse('{"__proto__":{}}')],
    [
      "nested prototype-named field",
      { environment: {} },
      JSON.parse('{"environment":{"__proto__":{"value":1}}}'),
    ],
    [
      "removed prototype-named field",
      JSON.parse('{"__proto__":{"value":1}}'),
      {},
    ],
  ])("round-trips %s as ordinary JSON data", (_label, previous, current) => {
    const patch = createJsonMergePatch(previous, current)
    expect(patch).toBeDefined()
    const durablePatch = JSON.parse(JSON.stringify(patch))
    const result = applyJsonMergePatch(previous, durablePatch)
    expect(JSON.stringify(result)).toBe(JSON.stringify(current))
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
  })

  it("applies a prototype-named field without changing object inheritance", () => {
    const target = { stable: true }
    const patch = JSON.parse('{"__proto__":{"value":1}}')
    const result = applyJsonMergePatch(target, patch)
    expect(Object.hasOwn(result, "__proto__")).toBe(true)
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(JSON.stringify(result)).toBe(
      '{"stable":true,"__proto__":{"value":1}}',
    )
    expect(target).toEqual({ stable: true })
  })
})
