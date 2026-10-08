import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type BrowserWindow, dialog, ipcMain, nativeImage } from "electron"
import {
  isImageAttachment,
  isPdfAttachment,
  type UserAttachment,
} from "../kernel/events.ts"
import { isStorageKey } from "../kernel/ids.ts"
import { rolloutAssetUrl } from "../server/asset-url.ts"
import { requireTrustedSender } from "./resource-opener.ts"
import type { ServerProcess } from "./server-process.ts"

const pickAttachmentsChannel = "yakitori:pick-attachments"
const importPickedAttachmentsChannel = "yakitori:import-picked-attachments"
const discardPickedAttachmentsChannel = "yakitori:discard-picked-attachments"
const importAttachmentFilesChannel = "yakitori:import-attachment-files"
const discardDraftAttachmentsChannel = "yakitori:discard-draft-attachments"
// App transport safety boundary, independent of provider attachment quotas.
const maxAttachmentFileBytes = 50_000_000

export function registerAttachmentImporter(
  server: ServerProcess,
  trustedWindow: BrowserWindow,
): void {
  const selections = new Map<
    string,
    Readonly<{ paths: readonly string[]; frame: Electron.WebFrameMain | null }>
  >()
  trustedWindow.once("closed", () => selections.clear())

  ipcMain.handle(pickAttachmentsChannel, async (event) => {
    requireTrustedSender(event.sender, event.senderFrame, trustedWindow)
    const picked = await dialog.showOpenDialog(trustedWindow, {
      title: "Attach images or PDFs",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Images and PDFs",
          extensions: ["png", "jpg", "jpeg", "gif", "webp", "pdf"],
        },
      ],
    })
    if (picked.canceled || picked.filePaths.length === 0) return
    requireTrustedSender(event.sender, event.senderFrame, trustedWindow)
    const selectionId = `attachment_selection_${randomUUID().replaceAll("-", "")}`
    selections.set(selectionId, {
      paths: picked.filePaths,
      frame: event.senderFrame,
    })
    return { selectionId }
  })

  ipcMain.handle(
    importPickedAttachmentsChannel,
    async (event, input: unknown) => {
      requireTrustedSender(event.sender, event.senderFrame, trustedWindow)
      const request = requirePickedAttachmentsRequest(input)
      const selection = selections.get(request.selectionId)
      // A selection is single-use even when the sidecar import fails.
      selections.delete(request.selectionId)
      if (selection === undefined || selection.frame !== event.senderFrame) {
        throw new Error("The selected attachments are no longer available.")
      }
      const target = attachmentImportTarget(request.sessionId)
      return validateImportedAttachments(
        server,
        requireAttachments(
          await server.request({
            type: "import_attachment_paths",
            ...target,
            ownerId: createDraftOwnerId(),
            paths: selection.paths,
          }),
        ),
        () =>
          requireTrustedSender(event.sender, event.senderFrame, trustedWindow),
      )
    },
  )

  ipcMain.handle(discardPickedAttachmentsChannel, (event, input: unknown) => {
    requireTrustedSender(event.sender, event.senderFrame, trustedWindow)
    selections.delete(requireSelectionId(input))
  })

  ipcMain.handle(
    importAttachmentFilesChannel,
    async (event, input: unknown) => {
      requireTrustedSender(event.sender, event.senderFrame, trustedWindow)
      const request = requireAttachmentFilesRequest(input)
      const temporaryDirectory = await mkdtemp(
        join(tmpdir(), "yakitori-attachments-"),
      )
      try {
        const paths: string[] = []
        for (const [index, item] of request.items.entries()) {
          if ("filePath" in item) paths.push(item.filePath)
          else {
            const path = join(temporaryDirectory, String(index + 1))
            await writeFile(path, item.data, { mode: 0o600 })
            paths.push(path)
          }
        }
        const attachments = await validateImportedAttachments(
          server,
          requireAttachments(
            await server.request({
              type: "import_attachment_paths",
              ...attachmentImportTarget(request.sessionId),
              ownerId: createDraftOwnerId(),
              paths,
            }),
          ),
          () =>
            requireTrustedSender(
              event.sender,
              event.senderFrame,
              trustedWindow,
            ),
        )
        return attachments.map((attachment, index) => ({
          ...attachment,
          name: request.items[index]?.name ?? attachment.name,
        }))
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true })
      }
    },
  )

  ipcMain.handle(
    discardDraftAttachmentsChannel,
    async (event, input: unknown) => {
      requireTrustedSender(event.sender, event.senderFrame, trustedWindow)
      if (
        !Array.isArray(input) ||
        !input.every(
          (attachment) =>
            isImageAttachment(attachment) || isPdfAttachment(attachment),
        )
      )
        throw new TypeError(
          "Draft attachments must be a valid attachment array.",
        )
      const response = await server.request({
        type: "discard_draft_attachments",
        attachments: input,
      })
      if (!response.ok) throw new Error(response.error)
    },
  )
}

async function validateImportedAttachments(
  server: ServerProcess,
  attachments: readonly UserAttachment[],
  requireCurrentOwner: () => void,
): Promise<readonly UserAttachment[]> {
  try {
    // The sidecar detects actual bytes and parses PDFs from the bounded copied
    // snapshot. Images additionally need full native decoding of that same
    // snapshot, never a second read of the mutable selected source path.
    for (const attachment of attachments) {
      if (attachment.mediaType === "application/pdf") continue
      const response = await fetch(attachmentUrl(server.url, attachment))
      if (!response.ok) throw new Error("Imported image could not be read.")
      const image = nativeImage.createFromBuffer(
        Buffer.from(await response.arrayBuffer()),
      )
      if (image.isEmpty())
        throw new Error(`${attachment.name} is not a valid image.`)
    }
    // A closed window or replaced frame must not strand staged imports.
    requireCurrentOwner()
    return attachments
  } catch (error) {
    const cleanup = await server.request({
      type: "discard_draft_attachments",
      attachments,
    })
    if (!cleanup.ok) {
      throw new AggregateError(
        [error, new Error(cleanup.error)],
        "Attachment validation and staging cleanup both failed.",
        { cause: error },
      )
    }
    throw error
  }
}

function attachmentUrl(serverUrl: string, attachment: UserAttachment): string {
  const url = rolloutAssetUrl(attachment.file, serverUrl)
  if (url === undefined) throw new Error("Invalid attachment source.")
  return url
}

function createDraftOwnerId(): string {
  return `draft_${randomUUID().replaceAll("-", "")}`
}

function optionalSessionId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Attachment import requires a Session ID.")
  }
  if (!("sessionId" in value) || value.sessionId === undefined) return
  if (!isStorageKey(value.sessionId)) {
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
    throw new TypeError("Picked attachment import requires a selection ID.")
  }
  return value.selectionId
}

function requirePickedAttachmentsRequest(value: unknown): Readonly<{
  sessionId?: string
  selectionId: string
}> {
  const sessionId = optionalSessionId(value)
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    selectionId: requireSelectionId(value),
  }
}

function requireAttachmentFilesRequest(value: unknown): Readonly<{
  sessionId?: string
  items: readonly (
    | Readonly<{ name: string; filePath: string }>
    | Readonly<{ name: string; data: Uint8Array }>
  )[]
}> {
  const sessionId = optionalSessionId(value)
  if (typeof value !== "object" || value === null || !("items" in value)) {
    throw new TypeError("Attachment import requires files.")
  }
  const items = value.items
  if (!Array.isArray(items)) {
    throw new TypeError("Attachment import requires files.")
  }
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    items: items.map((item: unknown) => {
      if (
        typeof item !== "object" ||
        item === null ||
        !("name" in item) ||
        typeof item.name !== "string" ||
        item.name.length === 0 ||
        Buffer.byteLength(item.name, "utf8") > 255 ||
        item.name.includes("\0")
      ) {
        throw new TypeError("Attachment import received an invalid file.")
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
        item.data.byteLength > maxAttachmentFileBytes
      ) {
        throw new TypeError("Attachment import received invalid file bytes.")
      }
      return { name: item.name, data: item.data }
    }),
  }
}

function attachmentImportTarget(
  sessionId: string | undefined,
): Readonly<{ sessionId: string } | { rolloutId: string }> {
  return sessionId === undefined
    ? { rolloutId: `draft_${randomUUID().replaceAll("-", "")}` }
    : { sessionId }
}

function requireAttachments(
  response: Awaited<ReturnType<ServerProcess["request"]>>,
): readonly UserAttachment[] {
  if (!response.ok) throw new Error(response.error)
  return response.attachments ?? []
}
