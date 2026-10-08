import { describe, expect, it } from "vitest"
import { createInputAttachmentOwnership } from "../../src/gui/input-attachment-ownership.ts"
import type { ImageAttachment, InputContent } from "../../src/kernel/events.ts"
import { inputFixture } from "../fixtures/user-input.ts"

const image: ImageAttachment = {
  name: "photo.png",
  mediaType: "image/png",
  sizeBytes: 10,
  detail: "original",
  file: {
    rolloutId: "rollout_source",
    path: "attachments/staging/upload/photo.png",
  },
}
const source: InputContent = inputFixture([
  { type: "text", text: "before" },
  { ...image, type: "image" },
  { type: "text", text: "after" },
])
const promoted = {
  rolloutId: "rollout_target",
  path: "attachments/requests/input/photo.png",
}
const accepted: InputContent = inputFixture([
  { type: "text", text: "before" },
  { ...image, type: "image", file: promoted },
  { type: "text", text: "after" },
])

describe("renderer input image ownership", () => {
  it("resolves staging references in place without changing text, detail or another API's ownership", () => {
    const ownership = createInputAttachmentOwnership()
    ownership.promote("http://localhost:1234/base/", source, accepted)
    expect(
      ownership.resolveDraft("http://localhost:1234/base", source),
    ).toEqual(accepted)
    expect(ownership.resolve("http://localhost:1234/other/", image)).toEqual(
      image,
    )
    expect(ownership.resolve("http://localhost:4321/base/", image)).toEqual(
      image,
    )
    expect(source.attachments[0]).toEqual(image)
    expect(
      ownership.resolve("http://localhost:1234/base/", {
        ...image,
        detail: "high",
      }),
    ).toEqual({ ...image, detail: "high", file: promoted })
  })

  it("never redirects existing durable history to another conversation's copy", () => {
    const ownership = createInputAttachmentOwnership()
    const durable = { ...image, file: promoted }
    const original: InputContent = inputFixture([{ ...durable, type: "image" }])
    ownership.promote(
      "http://localhost/",
      original,
      inputFixture([
        {
          ...durable,
          type: "image",
          file: {
            rolloutId: "rollout_other",
            path: "attachments/requests/other/photo.png",
          },
        },
      ]),
    )
    expect(ownership.resolve("http://localhost/", durable)).toEqual(durable)
  })

  it("rejects changed ordering, text and metadata instead of assigning unrelated assets", () => {
    const ownership = createInputAttachmentOwnership()
    expect(() =>
      ownership.promote("http://localhost/", source, {
        ...accepted,
        text: "changed",
      }),
    ).toThrow("does not match")
    expect(() =>
      ownership.promote(
        "http://localhost/",
        source,
        inputFixture([
          { type: "text", text: "changed" },
          { ...image, type: "image", file: promoted },
          { type: "text", text: "after" },
        ]),
      ),
    ).toThrow("does not match")
    expect(() =>
      ownership.promote(
        "http://localhost/",
        source,
        inputFixture([
          { type: "text", text: "before" },
          { ...image, name: "unrelated.png", type: "image", file: promoted },
          { type: "text", text: "after" },
        ]),
      ),
    ).toThrow("does not match")
    expect(ownership.resolve("http://localhost/", image)).toEqual(image)
  })

  it("validates the whole promotion before updating any reference and owns copies of metadata", () => {
    const ownership = createInputAttachmentOwnership()
    const other = {
      ...image,
      file: {
        rolloutId: "rollout_source",
        path: "attachments/staging/upload/second.png",
      },
    }
    expect(() =>
      ownership.promote(
        "http://localhost/",
        inputFixture([
          { ...image, type: "image" },
          { ...other, type: "image" },
        ]),
        inputFixture([
          { ...image, type: "image", file: promoted },
          { ...other, type: "image" },
        ]),
      ),
    ).toThrow("did not promote")
    expect(ownership.resolve("http://localhost/", image)).toEqual(image)
    const receipt = {
      rolloutId: "rollout_target",
      path: "attachments/requests/input/photo.png",
    }
    ownership.promote(
      "http://localhost/",
      inputFixture([{ ...image, type: "image" }]),
      inputFixture([{ ...image, type: "image", file: receipt }]),
    )
    receipt.path = "changed-after-acceptance"
    const resolved = ownership.resolve("http://localhost/", image)
    expect(resolved.file).toEqual(promoted)
    Object.assign(resolved.file, { path: "changed-by-consumer" })
    expect(ownership.resolve("http://localhost/", image).file).toEqual(promoted)
  })
})
