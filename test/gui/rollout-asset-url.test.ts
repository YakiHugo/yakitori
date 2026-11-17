import { expect, it } from "vitest"
import { rolloutAssetUrl } from "../../src/gui/rollout-asset-url.ts"

it.each([
  "tools/../report.pdf",
  "tools/./report.pdf",
  "tools/\\report.pdf",
  "tools/one/\nreport.pdf",
  "other/call/report.pdf",
])("rejects a path outside the asset contract: %j", (path) => {
  expect(
    rolloutAssetUrl({ rolloutId: "rollout_1", path }, "http://localhost:1234/"),
  ).toBeUndefined()
})

it.each([
  "javascript:alert(1)",
  "file:///tmp/",
  "https://name:secret@example.org/",
  "invalid",
])("rejects an unsafe API base %s", (base) => {
  expect(
    rolloutAssetUrl(
      { rolloutId: "rollout_1", path: "tools/call_1/report.pdf" },
      base,
    ),
  ).toBeUndefined()
})

it("encodes literal filename characters and rejects a traversal owner", () => {
  expect(
    rolloutAssetUrl(
      { rolloutId: "rollout_1", path: "tools/call/a #?.pdf" },
      "http://localhost:1234/base",
    ),
  ).toBe(
    "http://localhost:1234/base/rollouts/rollout_1/assets/tools/call/a%20%23%3F.pdf",
  )
  expect(
    rolloutAssetUrl(
      { rolloutId: "..", path: "tools/call/a.pdf" },
      "http://localhost:1234/",
    ),
  ).toBeUndefined()
})
