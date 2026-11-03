import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
  appendAttachmentFiles,
  createAttachmentUploadClient,
  discardDraftAttachments,
  pickAttachmentFiles,
} from "../../src/gui/composer-attachments.ts"

const uploadId = "12345678-1234-4123-8123-123456789abc"
const attachment = {
  name: "图.png",
  mediaType: "image/png" as const,
  sizeBytes: 3,
  file: {
    rolloutId: "draft_upload_12345678123441238123123456789abc",
    path: "attachments/staging/upload/1.png",
  },
}

beforeEach(() => {
  Object.defineProperty(window, "yakitoriDesktop", {
    configurable: true,
    value: undefined,
  })
})
afterEach(() => vi.unstubAllGlobals())

it("uploads actual bytes to a fixed handle and returns the portable server reference", async () => {
  const file = new File([new Uint8Array([1, 2, 3])], "图.png", {
    type: "image/png",
  })
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ attachment }))
  const client = createAttachmentUploadClient("http://127.0.0.1:8123", request)
  const signal = new AbortController().signal
  expect(await client.upload(file, uploadId, signal)).toEqual(attachment)
  const call = request.mock.calls[0]
  if (!call) throw new Error("Missing upload request")
  const [url, init] = call
  expect(String(url)).toBe(
    "http://127.0.0.1:8123/attachments/uploads/12345678-1234-4123-8123-123456789abc",
  )
  expect(init).toMatchObject({
    method: "PUT",
    body: file,
    signal,
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Yakitori-Attachment": "upload",
      "X-Attachment-Name": "%E5%9B%BE.png",
    },
  })
  if (!(init?.body instanceof File)) throw new Error("Missing file body")
  expect(await init.body.arrayBuffer()).toEqual(
    new Uint8Array([1, 2, 3]).buffer,
  )
})

it("rejects references that do not belong to the upload handle", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      attachment: {
        ...attachment,
        file: {
          rolloutId: "session_other",
          path: "attachments/staging/upload/1.png",
        },
      },
    }),
  )
  await expect(
    createAttachmentUploadClient("http://localhost", request).upload(
      new File(["x"], "x.png"),
      uploadId,
    ),
  ).rejects.toThrow("Invalid attachment upload response")
})

it("rolls back the whole batch including an uncertain upload without modifying the existing draft", async () => {
  const secondId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  vi.spyOn(crypto, "randomUUID")
    .mockReturnValueOnce(uploadId)
    .mockReturnValueOnce(secondId)
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ attachment }))
    .mockRejectedValueOnce(new TypeError("Network interrupted"))
    .mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal("fetch", request)
  const current = [attachment]
  await expect(
    appendAttachmentFiles(
      current,
      undefined,
      [
        new File(["one"], "one.png", { type: "image/png" }),
        new File(["two"], "two.png", { type: "image/png" }),
      ],
      "http://localhost:8123",
    ),
  ).rejects.toThrow("Network interrupted")
  expect(current).toEqual([attachment])
  expect(
    request.mock.calls.map(([url, init]) => [String(url), init?.method]),
  ).toEqual([
    [`http://localhost:8123/attachments/uploads/${uploadId}`, "PUT"],
    [`http://localhost:8123/attachments/uploads/${secondId}`, "PUT"],
    [`http://localhost:8123/attachments/uploads/${uploadId}`, "DELETE"],
    [`http://localhost:8123/attachments/uploads/${secondId}`, "DELETE"],
  ])
})

it("only discards fixed browser staging handles, never arbitrary rollout paths", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal("fetch", request)
  await discardDraftAttachments(
    [
      attachment,
      attachment,
      {
        ...attachment,
        file: {
          rolloutId: "session_existing",
          path: "attachments/requests/one/1.png",
        },
      },
    ],
    "http://localhost:8123",
  )
  expect(request).toHaveBeenCalledTimes(1)
  expect(request.mock.calls[0]?.[1]).toEqual({
    method: "DELETE",
    headers: { "X-Yakitori-Attachment": "upload" },
  })
})

it("rejects an invalid batch before transmitting any bytes", async () => {
  const request = vi.fn<typeof fetch>()
  vi.stubGlobal("fetch", request)
  await expect(
    appendAttachmentFiles([], undefined, [
      new File(["okay"], "okay.png", { type: "image/png" }),
      new File(["bad"], "script.js", { type: "text/javascript" }),
    ]),
  ).rejects.toThrow("Only PDF")
  expect(request).not.toHaveBeenCalled()
})

it("opens the browser picker synchronously and removes its input after cancellation", async () => {
  const click = vi
    .spyOn(HTMLInputElement.prototype, "click")
    .mockImplementation(() => {})
  const selection = pickAttachmentFiles()
  expect(click).toHaveBeenCalledOnce()
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error("Missing file picker")
  expect(input.multiple).toBe(true)
  input.dispatchEvent(new Event("cancel"))
  expect(await selection).toEqual([])
  expect(document.querySelector('input[type="file"]')).toBeNull()
})

it("does not start an upload after cancellation", async () => {
  const request = vi.fn<typeof fetch>()
  vi.stubGlobal("fetch", request)
  const controller = new AbortController()
  controller.abort()
  await expect(
    appendAttachmentFiles(
      [],
      undefined,
      [new File(["x"], "x.png", { type: "image/png" })],
      "http://localhost",
      controller.signal,
    ),
  ).rejects.toThrow()
  expect(request).not.toHaveBeenCalled()
})

it.each([
  "discard",
  "rollback",
])("bounds %s cleanup to one request and attempts every handle after a failure", async (mode) => {
  const ids = Array.from(
    { length: 6 },
    (_, index) =>
      `12345678-1234-4123-8123-123456789ab${index}` as `${string}-${string}-${string}-${string}-${string}`,
  )
  const attachments = ids.map((id) => ({
    ...attachment,
    file: {
      ...attachment.file,
      rolloutId: `draft_upload_${id.replaceAll("-", "")}`,
    },
  }))
  const deleted: string[] = []
  let active = 0
  let peak = 0
  let uploads = 0
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url, init) => {
      if (init?.method === "PUT") {
        const index = uploads++
        if (index === 5) throw new Error("Upload interrupted")
        return Response.json({ attachment: attachments[index] })
      }
      active++
      peak = Math.max(peak, active)
      deleted.push(String(url))
      await new Promise((resolve) => setTimeout(resolve, 1))
      active--
      return new Response(null, { status: deleted.length === 2 ? 500 : 204 })
    })
  vi.stubGlobal("fetch", request)
  const uuid = vi.spyOn(crypto, "randomUUID")
  for (const id of ids) uuid.mockReturnValueOnce(id)
  const operation =
    mode === "discard"
      ? discardDraftAttachments(attachments, "http://localhost:8123")
      : appendAttachmentFiles(
          [],
          undefined,
          ids.map(() => new File(["png"], "image.png", { type: "image/png" })),
          "http://localhost:8123",
        )
  await expect(operation).rejects.toBeInstanceOf(AggregateError)
  expect(peak).toBe(1)
  expect(deleted).toEqual(
    ids.map((id) => `http://localhost:8123/attachments/uploads/${id}`),
  )
})
