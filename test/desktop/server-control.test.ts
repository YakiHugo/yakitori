import { describe, expect, it } from "vitest"
import {
  isServerControlRequest,
  isServerControlResponse,
} from "../../src/desktop/server-control.ts"

const pdf = {
  name: "report.pdf",
  mediaType: "application/pdf",
  sizeBytes: 123,
  file: {
    rolloutId: "draft_rollout",
    path: "attachments/staging/draft_owner/1.pdf",
  },
}

const target = {
  requestId: "request_1",
  rolloutId: "draft_rollout",
  ownerId: "draft_owner",
}

describe("attachment sidecar control validation", () => {
  it("accepts PDF responses and draft cleanup without image-only detail fields", () => {
    expect(
      isServerControlResponse({
        requestId: "request_1",
        ok: true,
        attachments: [pdf],
      }),
    ).toBe(true)
    expect(
      isServerControlRequest({
        requestId: "request_1",
        type: "discard_draft_attachments",
        attachments: [pdf],
      }),
    ).toBe(true)
  })

  it.each([
    { ...pdf, sizeBytes: -1 },
    { ...pdf, sizeBytes: Number.POSITIVE_INFINITY },
    { ...pdf, mediaType: "text/plain" },
    { ...pdf, file: { rolloutId: "../escaped", path: "1.pdf" } },
    { ...pdf, detail: "high" },
  ])("rejects forged PDF metadata at both control boundaries", (attachment) => {
    expect(
      isServerControlResponse({
        requestId: "request_1",
        ok: true,
        attachments: [attachment],
      }),
    ).toBe(false)
    expect(
      isServerControlRequest({
        requestId: "request_1",
        type: "discard_draft_attachments",
        attachments: [attachment],
      }),
    ).toBe(false)
  })

  it("requires real byte arrays and a single valid import target", () => {
    const command = {
      ...target,
      type: "import_attachment_bytes",
      items: [{ name: "report.pdf", data: new Uint8Array([1, 2]) }],
    }
    expect(isServerControlRequest(command)).toBe(true)
    expect(
      isServerControlRequest({
        ...command,
        items: [{ name: "report.pdf", data: [1, 2] }],
      }),
    ).toBe(false)
    expect(isServerControlRequest({ ...command, sessionId: "session_1" })).toBe(
      false,
    )
    expect(isServerControlRequest({ ...command, ownerId: "../escaped" })).toBe(
      false,
    )
  })

  it("retains the privileged path command without accepting an empty source path", () => {
    expect(
      isServerControlRequest({
        ...target,
        type: "import_attachment_paths",
        paths: ["/selected/report.pdf"],
      }),
    ).toBe(true)
    expect(
      isServerControlRequest({
        ...target,
        type: "import_attachment_paths",
        paths: [""],
      }),
    ).toBe(false)
  })
})
