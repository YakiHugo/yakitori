import { describe, expect, it, vi } from "vitest"
import {
  jsonRequestByteLength,
  JsonRequestBudgetError,
} from "../../src/runtime/json-request-budget.ts"

describe("plain JSON request byte budget", () => {
  const shared = { text: "same object, distinct wire occurrences" }
  const corpus: unknown[] = [
    null,
    true,
    false,
    0,
    -0,
    0.00000001,
    1e30,
    NaN,
    Infinity,
    -Infinity,
    "",
    "ASCII",
    "é汉語🙂",
    "\u2028\u2029",
    '"\\\b\f\n\r\t\u0000\u0001\u001f\u007f',
    "\ud800",
    "\udfff",
    "\ud800a\udfff",
    "\ud800\ud800\udc00\udfff",
    [],
    {},
    [undefined, null, "last"],
    new Array(3),
    {
      omitted: undefined,
      present: "yes",
      nested: [undefined, { omitted: undefined }],
    },
    { 'quote"slash\\': "line\n", "汉语🙂": "\ud800", "\u0001": 1 },
    [shared, shared],
    Object.assign(Object.create(null), { value: "null prototype" }),
  ]
  it.each(
    corpus.map((value, index) => ({ value, index })),
  )("matches independently serialized UTF-8 size and exact boundaries ($index)", ({
    value,
  }) => {
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8")
    expect(jsonRequestByteLength(value, bytes - 1)).toBeUndefined()
    expect(jsonRequestByteLength(value, bytes)).toBe(bytes)
    expect(jsonRequestByteLength(value, bytes + 1)).toBe(bytes)
  })

  it("matches escaped key and value sizes across all UTF-16 code units", () => {
    for (let start = 0; start < 65536; start += 256) {
      const text = String.fromCharCode(
        ...Array.from({ length: 256 }, (_, i) => start + i),
      )
      const value = { [text]: text }
      const expected = Buffer.byteLength(JSON.stringify(value), "utf8")
      expect(jsonRequestByteLength(value, expected)).toBe(expected)
      expect(jsonRequestByteLength(value, expected - 1)).toBeUndefined()
    }
  })

  it("handles wide objects and repeated references without deduplicating their wire size", () => {
    const value = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => [`key${index}`, shared]),
    )
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8")
    expect(jsonRequestByteLength(value, bytes)).toBe(bytes)
    expect(jsonRequestByteLength(value, bytes - 1)).toBeUndefined()
  })

  it("counts deep containers without relying on the JavaScript call-stack limit", () => {
    let value: unknown = null
    for (let depth = 0; depth < 20_000; depth += 1) value = [value]
    // 20,000 pairs of brackets around the four-byte literal null.
    expect(jsonRequestByteLength(value, 40_004)).toBe(40_004)
    expect(jsonRequestByteLength(value, 40_003)).toBeUndefined()
  })

  it("stops scanning long strings as soon as their budget is exhausted", () => {
    const value = "a".repeat(1_000_000)
    const charCodeAt = vi.spyOn(String.prototype, "charCodeAt")
    let result: number | undefined
    let inspected: number
    try {
      result = jsonRequestByteLength(value, 10)
      inspected = charCodeAt.mock.calls.length
    } finally {
      charCodeAt.mockRestore()
    }
    expect(result).toBeUndefined()
    // Eight payload bytes fit after the quotes; the ninth exhausts the budget.
    expect(inspected).toBe(9)
  })

  it("rejects accessors and custom serialization without executing them", () => {
    let calls = 0
    const getter = () => {
      calls += 1
      return "hidden"
    }
    const object = Object.defineProperty({}, "text", {
      enumerable: true,
      get: getter,
    })
    const array = Object.defineProperty([null], "0", { get: getter })
    const toJsonGetter = Object.defineProperty({}, "toJSON", { get: getter })
    const custom = {
      toJSON() {
        calls += 1
        return "custom"
      },
    }
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          calls += 1
          return null
        },
      },
    )
    for (const value of [object, array, toJsonGetter, custom, proxy])
      expect(() => jsonRequestByteLength(value, 100)).toThrow(
        JsonRequestBudgetError,
      )
    expect(calls).toBe(0)
  })

  it("rejects invalid budgets and unsupported serialization rather than returning an incorrect size", () => {
    for (const budget of [-1, 0.5, NaN, Infinity])
      expect(() => jsonRequestByteLength({}, budget)).toThrow(RangeError)
    for (const value of [
      undefined,
      1n,
      new Date(0),
      {
        toJSON() {
          return "custom"
        },
      },
    ])
      expect(() => jsonRequestByteLength(value, 100)).toThrow(
        JsonRequestBudgetError,
      )
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => jsonRequestByteLength(cyclic, 100)).toThrow("Cyclic")
    expect(jsonRequestByteLength({}, 0)).toBeUndefined()
  })
})
