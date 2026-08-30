import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type BrowserWindow, dialog, ipcMain, nativeImage } from "electron"
import type { ImageAttachment } from "../kernel/events.ts"
import type { ServerProcess } from "./server-process.ts"
import { requireTrustedSender } from "./resource-opener.ts"

const pickImagesChannel = "yakitori:pick-images"
const importImageFilesChannel = "yakitori:import-image-files"
const discardDraftImagesChannel = "yakitori:discard-draft-images"
const maxImageFileBytes = 50_000_000

export function registerAttachmentImporter(
  server: ServerProcess,
  trustedWindow: BrowserWindow,
): void {
  ipcMain.handle(pickImagesChannel, async (event, input: unknown) => {
    requireTrustedSender(event.sender, event.senderFrame, trustedWindow)
    const sessionId = requireSessionId(input)
    const picked = await dialog.showOpenDialog(trustedWindow, {
      title: "Attach images",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "gif", "webp"],
        },
      ],
    })
    if (picked.canceled || picked.filePaths.length === 0) return []
    return validateImportedImages(
      server,
      requireAttachments(
        await server.request({
          type: "import_image_paths",
          sessionId,
          ownerId: createDraftOwnerId(),
          paths: picked.filePaths,
        }),
      ),
    )
  })

  ipcMain.handle(importImageFilesChannel, async (event, input: unknown) => {
    requireTrustedSender(event.sender, event.senderFrame, trustedWindow)
    const request = requireImageFilesRequest(input)
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "yakitori-images-"))
    try {
      const paths = await Promise.all(
        request.items.map(async (item, index) => {
          if ("filePath" in item) return item.filePath
          const path = join(temporaryDirectory, String(index + 1))
          await writeFile(path, item.data, { mode: 0o600 })
          return path
        }),
      )
      const attachments = await validateImportedImages(
        server,
        requireAttachments(
          await server.request({
            type: "import_image_paths",
            sessionId: request.sessionId,
            ownerId: createDraftOwnerId(),
            paths,
          }),
        ),
      )
      return attachments.map((attachment, index) => ({
        ...attachment,
        name: request.items[index]?.name ?? attachment.name,
      }))
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  ipcMain.handle(discardDraftImagesChannel, async (event, input: unknown) => {
    requireTrustedSender(event.sender, event.senderFrame, trustedWindow)
    if (!Array.isArray(input))
      throw new TypeError("Draft images must be an array.")
    const response = await server.request({
      type: "discard_draft_images",
      attachments: input as readonly ImageAttachment[],
    })
    if (!response.ok) throw new Error(response.error)
  })
}

async function validateImportedImages(
  server: ServerProcess,
  attachments: readonly ImageAttachment[],
): Promise<readonly ImageAttachment[]> {
  try {
    // The sidecar validates bounded metadata from the copied snapshot. The
    // desktop boundary additionally performs full decoding on that same
    // stored snapshot before exposing it to the composer.
    for (const attachment of attachments) {
      const response = await fetch(attachmentUrl(server.url, attachment))
      if (!response.ok) throw new Error("Imported image could not be read.")
      const image = nativeImage.createFromBuffer(
        Buffer.from(await response.arrayBuffer()),
      )
      if (image.isEmpty())
        throw new Error(`${attachment.name} is not a valid image.`)
    }
    return attachments
  } catch (error) {
    const cleanup = await server.request({
      type: "discard_draft_images",
      attachments,
    })
    if (!cleanup.ok) {
      throw new AggregateError(
        [error, new Error(cleanup.error)],
        "Image validation and staging cleanup both failed.",
        { cause: error },
      )
    }
    throw error
  }
}

function attachmentUrl(serverUrl: string, attachment: ImageAttachment): string {
  const path = attachment.file.path.split("/").map(encodeURIComponent).join("/")
  return `${serverUrl}/rollouts/${encodeURIComponent(attachment.file.rolloutId)}/assets/${path}`
}

function createDraftOwnerId(): string {
  return `draft_${randomUUID().replaceAll("-", "")}`
}

function requireSessionId(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    !("sessionId" in value) ||
    typeof value.sessionId !== "string" ||
    value.sessionId.length === 0
  ) {
    throw new TypeError("Attachment import requires a Session ID.")
  }
  return value.sessionId
}

function requireImageFilesRequest(value: unknown): {
  readonly sessionId: string
  readonly items: readonly (
    | { readonly name: string; readonly filePath: string }
    | { readonly name: string; readonly data: Uint8Array }
  )[]
} {
  const sessionId = requireSessionId(value)
  if (typeof value !== "object" || value === null || !("items" in value)) {
    throw new TypeError("Attachment import requires image files.")
  }
  const items = value.items
  if (!Array.isArray(items)) {
    throw new TypeError("Attachment import requires image files.")
  }
  return {
    sessionId,
    items: items.map((item: unknown) => {
      if (
        typeof item !== "object" ||
        item === null ||
        !("name" in item) ||
        typeof item.name !== "string"
      ) {
        throw new TypeError("Attachment import received an invalid image.")
      }
      if (
        "filePath" in item &&
        typeof item.filePath === "string" &&
        item.filePath.length > 0
      ) {
        return { name: item.name, filePath: item.filePath }
      }
      if (
        !("data" in item) ||
        !(item.data instanceof Uint8Array) ||
        item.data.byteLength > maxImageFileBytes
      ) {
        throw new TypeError("Attachment import received invalid image bytes.")
      }
      return { name: item.name, data: item.data }
    }),
  }
}

function requireAttachments(
  response: Awaited<ReturnType<ServerProcess["request"]>>,
): readonly ImageAttachment[] {
  if (!response.ok) throw new Error(response.error)
  return response.attachments ?? []
}
