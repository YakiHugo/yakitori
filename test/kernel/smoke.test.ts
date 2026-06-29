import { describe, expect, it } from "vitest"

describe("toolchain", () => {
  it("runs Vitest through the Vite toolchain", () => {
    expect("yakitori").toBe("yakitori")
  })
})
