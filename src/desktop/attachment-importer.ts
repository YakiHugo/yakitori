import { randomUUID } from "node:crypto"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type BrowserWindow, dialog, ipcMain, nativeImage } from "electron"
import type { ImageAttachment } from "../kernel/events.ts"
import { requireTrustedSender } from "./resource-opener.ts"
import type { ServerProcess } from "./server-process.ts"

const pickImagesChannel = "yakitori:pick-images"
const importPickedImagesChannel = "yakitori:import-picked-images"
const discardPickedImagesChannel = "yakitori:discard-picked-images"
const importImageFilesChannel = "yakitori:import-image-files"
const discardDraftImagesChannel = "yakitori:discard-draft-images"
const maxImageFileBytes = 50_000_000

export function registerAttachmentImporter(
  server: ServerProcess,
  trustedWindow: BrowserWindow,
): void {
  const selections = new Map<string, readonly string[]>()
  trustedWindow.once("closed", () => selections.clear())

  ipcMain.handle(pickImagesChannel, async (event) => {
    requireTrustedSender(event.sender, event.senderFrame, trustedWindow)
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
    if (picked.canceled || picked.filePaths.length === 0) return
    await validateSelectedImagePaths(picked.filePaths)
    const selectionId = `image_selection_${randomUUID().replaceAll("-", "")}`
    selections.set(selectionId, picked.filePaths)
    return { selectionId }
  })

  ipcMain.handle(importPickedImagesChannel, async (event, input: unknown) => {
    requireTrustedSender(event.sender, event.senderFrame, trustedWindow)
    const request = requirePickedImagesRequest(input)
    const paths = selections.get(request.selectionId)
    if (paths === undefined) {
      throw new Error("The selected images are no longer available.")
    }
    // A selection is single-use even when the sidecar import fails.
    selections.delete(request.selectionId)
    const target = attachmentImportTarget(request.sessionId)
    return validateImportedImages(
      server,
      requireAttachments(
        await server.request({
          type: "import_image_paths",
          ...target,
          ownerId: createDraftOwnerId(),
          paths,
        }),
      ),
    )
  })

  ipcMain.handle(discardPickedImagesChannel, (event, input: unknown) => {
    requireTrustedSender(event.sender, event.senderFrame, trustedWindow)
    selections.delete(requireSelectionId(input))
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
            ...attachmentImportTarget(request.sessionId),
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

async function validateSelectedImagePaths(
  paths: readonly string[],
): Promise<void> {
  for (const path of paths) {
    const metadata = await stat(path)
    if (!metadata.isFile() || metadata.size > maxImageFileBytes) {
      throw new Error("Image must be a file no larger than 50 MB.")
    }
    if (nativeImage.createFromPath(path).isEmpty()) {
      throw new Error(`${path} is not a valid image.`)
    }
  }
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

function optionalSessionId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Attachment import requires a Session ID.")
  }
  if (!("sessionId" in value) || value.sessionId === undefined) return
  if (typeof value.sessionId !== "string" || value.sessionId.length === 0) {
    throw new TypeError("Attachment import requires a Session ID.")
  }
  return value.sessionId
}

function requireSelectionId(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    !("selectionId" in value) ||
    typeof value.selectionId !== "string" ||
    value.selectionId.length === 0
  ) {
    throw new TypeError("Picked image import requires a selection ID.")
  }
  return value.selectionId
}

function requirePickedImagesRequest(value: unknown): {
  readonly sessionId?: string
  readonly selectionId: string
} {
  const sessionId = optionalSessionId(value)
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    selectionId: requireSelectionId(value),
  }
}

function requireImageFilesRequest(value: unknown): {
  readonly sessionId?: string
  readonly items: readonly (
    | { readonly name: string; readonly filePath: string }
    | { readonly name: string; readonly data: Uint8Array }
  )[]
} {
  const sessionId = optionalSessionId(value)
  if (typeof value !== "object" || value === null || !("items" in value)) {
    throw new TypeError("Attachment import requires image files.")
  }
  const items = value.items
  if (!Array.isArray(items)) {
    throw new TypeError("Attachment import requires image files.")
  }
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
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

function attachmentImportTarget(
  sessionId: string | undefined,
): { readonly sessionId: string } | { readonly rolloutId: string } {
  return sessionId === undefined
    ? { rolloutId: `draft_${randomUUID().replaceAll("-", "")}` }
    : { sessionId }
}

function requireAttachments(
  response: Awaited<ReturnType<ServerProcess["request"]>>,
): readonly ImageAttachment[] {
  if (!response.ok) throw new Error(response.error)
  return response.attachments ?? []
}
