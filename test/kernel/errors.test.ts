import { describe, expect, it } from "vitest"
import {
  createYakitoriError,
  isYakitoriError,
  YakitoriErrorCode,
} from "../../src/index.ts"

describe("kernel errors", () => {
  it("carries stable error code, details, and cause", () => {
    const cause = new SyntaxError("bad json")
    const error = createYakitoriError({
      code: YakitoriErrorCode.InvalidEventLog,
      message: "Invalid event JSON at line 1.",
      details: {
        lineNumber: 1,
      },
      cause,
    })

    expect(isYakitoriError(error)).toBe(true)
    expect(error).toMatchObject({
      name: "YakitoriError",
      code: YakitoriErrorCode.InvalidEventLog,
      message: "Invalid event JSON at line 1.",
      details: {
        lineNumber: 1,
      },
      cause,
    })
    expect(error.toJSON()).toEqual({
      message: "Invalid event JSON at line 1.",
      code: YakitoriErrorCode.InvalidEventLog,
      details: {
        lineNumber: 1,
      },
    })
  })
})
