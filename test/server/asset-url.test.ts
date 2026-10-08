import { describe, expect, it } from "vitest"
import {
  requireAssetBaseUrl,
  rolloutAssetUrl,
} from "../../src/server/asset-url.ts"

describe("asset access addresses", () => {
  const file = {
    rolloutId: "rollout_one",
    path: "attachments/requests/request_one/my image.png",
  }

  it("keeps deployment prefixes and encodes owned paths", () => {
    expect(rolloutAssetUrl(file, "https://cdn.example/yakitori/api")).toBe(
      "https://cdn.example/yakitori/api/rollouts/rollout_one/assets/attachments/requests/request_one/my%20image.png",
    )
    expect(requireAssetBaseUrl("https://cdn.example/yakitori/api")).toBe(
      "https://cdn.example/yakitori/api/",
    )
    expect(
      rolloutAssetUrl(
        { url: "https://other.example/image.png?token=fixture" },
        "http://localhost:4141",
      ),
    ).toBe("https://other.example/image.png?token=fixture")
  })

  it("rejects traversal, foreign routes and unsafe bases", () => {
    for (const path of [
      "attachments/../health",
      "tools/call/../../config",
      "images/image.png",
      "attachments/request/back\\slash.png",
      "attachments/request/\u0000.png",
    ])
      expect(
        rolloutAssetUrl({ ...file, path }, "https://cdn.example"),
      ).toBeUndefined()
    for (const base of [
      "file:///tmp",
      "https://user:password@cdn.example",
      "https://cdn.example?token=x",
      "https://cdn.example/#route",
      " https://cdn.example",
    ])
      expect(() => requireAssetBaseUrl(base)).toThrow(TypeError)
  })
})
