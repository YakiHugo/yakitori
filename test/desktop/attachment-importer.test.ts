import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerAttachmentImporter } from "../../src/desktop/attachment-importer.ts"
import type { ServerControlCommand } from "../../src/desktop/server-control.ts"
import type { ServerProcess } from "../../src/desktop/server-process.ts"
import type { UserAttachment } from "../../src/kernel/events.ts"

type IpcEvent = {
  readonly sender: unknown
  readonly senderFrame: unknown
}
type IpcHandler = (event: IpcEvent, input?: unknown) => unknown

const electron = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>()
  return {
    handlers,
    showOpenDialog: vi.fn(),
    createFromPath: vi.fn(() => ({ isEmpty: (): boolean => false })),
    createFromBuffer: vi.fn(() => ({ isEmpty: (): boolean => false })),
  }
})

vi.mock("electron", () => ({
  dialog: { showOpenDialog: electron.showOpenDialog },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      electron.handlers.set(channel, handler)
    },
  },
  nativeImage: {
    createFromPath: electron.createFromPath,
    createFromBuffer: electron.createFromBuffer,
  },
}))

const temporaryDirectories: string[] = []

beforeEach(() => {
  electron.handlers.clear()
  electron.showOpenDialog.mockReset()
  electron.createFromPath.mockClear()
  electron.createFromBuffer.mockReset()
  electron.createFromBuffer.mockReturnValue({ isEmpty: (): boolean => false })
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
  )
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe("desktop attachment importer", () => {
  it("returns no selection token when the picker is canceled", async () => {
    electron.showOpenDialog.mockResolvedValue({
      canceled: true,
      filePaths: [],
    })
    const { event } = register()

    await expect(
      handler("yakitori:pick-attachments")(event),
    ).resolves.toBeUndefined()
  })

  it("keeps selected paths in the main process and consumes the token once", async () => {
    const directory = await temporaryDirectory()
    const imagePath = path.join(directory, "shot.png")
    await writeFile(imagePath, new Uint8Array([1, 2, 3]))
    electron.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [imagePath],
    })
    const { event, request } = register()

    const selection = (await handler("yakitori:pick-attachments")(event)) as {
      readonly selectionId: string
    }
    expect(selection).toEqual({
      selectionId: expect.stringMatching(/^attachment_selection_/),
    })
    expect(selection).not.toHaveProperty("filePaths")

    await expect(
      handler("yakitori:import-picked-attachments")(event, {
        sessionId: "session_1",
        selectionId: selection.selectionId,
      }),
    ).resolves.toEqual([attachment])
    expect(request).toHaveBeenCalledWith({
      type: "import_attachment_paths",
      sessionId: "session_1",
      ownerId: expect.stringMatching(/^draft_/),
      paths: [imagePath],
    })
    await expect(
      handler("yakitori:import-picked-attachments")(event, {
        sessionId: "session_1",
        selectionId: selection.selectionId,
      }),
    ).rejects.toThrow("no longer available")
  })

  it("discards an abandoned selection token", async () => {
    const directory = await temporaryDirectory()
    const imagePath = path.join(directory, "shot.png")
    await writeFile(imagePath, new Uint8Array([1, 2, 3]))
    electron.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [imagePath],
    })
    const { event } = register()
    const selection = (await handler("yakitori:pick-attachments")(event)) as {
      readonly selectionId: string
    }

    await handler("yakitori:discard-picked-attachments")(event, selection)

    await expect(
      handler("yakitori:import-picked-attachments")(event, {
        sessionId: "session_1",
        selectionId: selection.selectionId,
      }),
    ).rejects.toThrow("no longer available")
  })

  it("stages a picked image under a draft rollout without a session", async () => {
    const directory = await temporaryDirectory()
    const imagePath = path.join(directory, "shot.png")
    await writeFile(imagePath, new Uint8Array([1, 2, 3]))
    electron.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [imagePath],
    })
    const { event, request } = register()
    const selection = (await handler("yakitori:pick-attachments")(event)) as {
      readonly selectionId: string
    }

    await handler("yakitori:import-picked-attachments")(event, {
      selectionId: selection.selectionId,
    })

    expect(request).toHaveBeenCalledWith({
      type: "import_attachment_paths",
      rolloutId: expect.stringMatching(/^draft_[0-9a-f]+$/),
      ownerId: expect.stringMatching(/^draft_/),
      paths: [imagePath],
    })
  })

  it("clears abandoned selection tokens when the window closes", async () => {
    electron.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["/selected/report.pdf"],
    })
    const { event, trustedWindow } = register()
    const selection = await handler("yakitori:pick-attachments")(event)
    const onClosed = trustedWindow.once.mock.calls[0]?.[1]
    if (onClosed === undefined)
      throw new Error("Window cleanup was not registered")
    onClosed()
    await expect(
      handler("yakitori:import-picked-attachments")(event, selection),
    ).rejects.toThrow("no longer available")
  })

  it("rejects invalid target identifiers before privileged IPC", async () => {
    const { event, request } = register()
    await expect(
      handler("yakitori:import-attachment-files")(event, {
        sessionId: "../invalid",
        items: [],
      }),
    ).rejects.toThrow("Session ID")
    expect(request).not.toHaveBeenCalled()
  })

  it("imports picked PDFs and images in selection order and decodes only stored images", async () => {
    const paths = ["/selected/report.dat", "/selected/shot.png"]
    electron.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: paths,
    })
    const { event, request } = register([pdfAttachment, attachment])
    const selection = await handler("yakitori:pick-attachments")(event)

    await expect(
      handler("yakitori:import-picked-attachments")(event, selection),
    ).resolves.toEqual([pdfAttachment, attachment])

    expect(request).toHaveBeenCalledWith(expect.objectContaining({ paths }))
    expect(electron.createFromPath).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "http://127.0.0.1:4141/rollouts/session_1/assets/attachments/staging/draft_1/1.png",
    )
    expect(electron.createFromBuffer).toHaveBeenCalledExactlyOnceWith(
      Buffer.from([1, 2, 3]),
    )
    expect(electron.showOpenDialog.mock.calls[0]?.[1]).toMatchObject({
      filters: [{ extensions: ["png", "jpg", "jpeg", "gif", "webp", "pdf"] }],
    })
  })

  it("cleans the whole mixed batch when decoding a stored image fails", async () => {
    const { event, request } = register([pdfAttachment, attachment])
    electron.createFromBuffer.mockReturnValue({ isEmpty: () => true })

    await expect(
      handler("yakitori:import-attachment-files")(event, {
        items: [
          { name: "report.pdf", data: new Uint8Array([1]) },
          { name: "shot.png", filePath: "/selected/shot.png" },
        ],
      }),
    ).rejects.toThrow("not a valid image")

    expect(request).toHaveBeenLastCalledWith({
      type: "discard_draft_attachments",
      attachments: [pdfAttachment, attachment],
    })
  })

  it("consumes picked tokens even when the sidecar rejects an invalid PDF", async () => {
    electron.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["/selected/broken.pdf"],
    })
    const { event, request } = register()
    const selection = await handler("yakitori:pick-attachments")(event)
    request.mockRejectedValueOnce(new Error("PDF is invalid"))
    await expect(
      handler("yakitori:import-picked-attachments")(event, selection),
    ).rejects.toThrow("PDF is invalid")
    await expect(
      handler("yakitori:import-picked-attachments")(event, selection),
    ).rejects.toThrow("no longer available")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("does not expose a selection after its picker window closes", async () => {
    const { event, trustedWindow } = register()
    electron.showOpenDialog.mockImplementation(async () => {
      trustedWindow.isDestroyed.mockReturnValue(true)
      return { canceled: false, filePaths: ["/selected/report.pdf"] }
    })
    await expect(handler("yakitori:pick-attachments")(event)).rejects.toThrow(
      "untrusted frame",
    )
  })

  it("expires selections belonging to a replaced main frame", async () => {
    const { event, trustedWindow, request } = register()
    electron.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["/selected/report.pdf"],
    })
    const selection = await handler("yakitori:pick-attachments")(event)
    trustedWindow.webContents.mainFrame = {}
    await expect(
      handler("yakitori:import-picked-attachments")(
        {
          sender: trustedWindow.webContents,
          senderFrame: trustedWindow.webContents.mainFrame,
        },
        selection,
      ),
    ).rejects.toThrow("no longer available")
    expect(request).not.toHaveBeenCalled()
  })

  it("cleans stored attachments when their owner disappears during import", async () => {
    const { event, trustedWindow, request } = register([pdfAttachment])
    request.mockImplementationOnce(async () => {
      trustedWindow.isDestroyed.mockReturnValue(true)
      return {
        requestId: "request_test",
        ok: true,
        attachments: [pdfAttachment],
      }
    })
    await expect(
      handler("yakitori:import-attachment-files")(event, {
        items: [{ name: "report.pdf", filePath: "/selected/report.pdf" }],
      }),
    ).rejects.toThrow("untrusted frame")
    expect(request).toHaveBeenLastCalledWith({
      type: "discard_draft_attachments",
      attachments: [pdfAttachment],
    })
  })

  it.each([
    "yakitori:pick-attachments",
    "yakitori:import-picked-attachments",
    "yakitori:discard-picked-attachments",
    "yakitori:import-attachment-files",
    "yakitori:discard-draft-attachments",
  ])("rejects forged subframe requests to %s before side effects", async (channel) => {
    const { event, request } = register()
    await expect(
      Promise.resolve().then(() =>
        handler(channel)(
          {
            sender: event.sender,
            senderFrame: {},
          },
          { selectionId: "forged", items: [] },
        ),
      ),
    ).rejects.toThrow("untrusted frame")
    expect(request).not.toHaveBeenCalled()
    expect(electron.showOpenDialog).not.toHaveBeenCalled()
  })

  it("preserves mixed path and byte order and removes temporary byte snapshots", async () => {
    const { event, request } = register([pdfAttachment, attachment])
    let temporaryPath = ""
    request.mockImplementationOnce(async (command) => {
      if (command.type !== "import_attachment_paths")
        throw new Error("Unexpected command")
      expect(command.paths[0]).toBe("/selected/report.pdf")
      temporaryPath = command.paths[1] ?? ""
      expect(await readFile(temporaryPath)).toEqual(Buffer.from([5, 6, 7]))
      return {
        requestId: "request_test",
        ok: true,
        attachments: [pdfAttachment, attachment],
      }
    })
    await expect(
      handler("yakitori:import-attachment-files")(event, {
        items: [
          { name: "report.pdf", filePath: "/selected/report.pdf" },
          { name: "pasted.png", data: new Uint8Array([5, 6, 7]) },
        ],
      }),
    ).resolves.toEqual([pdfAttachment, { ...attachment, name: "pasted.png" }])
    await expect(stat(temporaryPath)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("removes temporary byte snapshots after a failed sidecar import", async () => {
    const { event, request } = register()
    let temporaryPath = ""
    request.mockImplementationOnce(async (command) => {
      if (command.type !== "import_attachment_paths")
        throw new Error("Unexpected command")
      temporaryPath = command.paths[0] ?? ""
      throw new Error("Invalid PDF")
    })
    await expect(
      handler("yakitori:import-attachment-files")(event, {
        items: [{ name: "invalid.pdf", data: new Uint8Array([5]) }],
      }),
    ).rejects.toThrow("Invalid PDF")
    await expect(stat(temporaryPath)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects forged draft metadata without sending an unanswered sidecar command", async () => {
    const { event, request } = register()
    await expect(
      handler("yakitori:discard-draft-attachments")(event, [
        { ...pdfAttachment, sizeBytes: -1 },
      ]),
    ).rejects.toThrow("valid attachment array")
    expect(request).not.toHaveBeenCalled()
    await expect(
      handler("yakitori:discard-draft-attachments")(event, [pdfAttachment]),
    ).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith({
      type: "discard_draft_attachments",
      attachments: [pdfAttachment],
    })
  })
})

const attachment: UserAttachment = {
  name: "shot.png",
  mediaType: "image/png",
  detail: "high",
  sizeBytes: 3,
  file: {
    rolloutId: "session_1",
    path: "attachments/staging/draft_1/1.png",
  },
}

const pdfAttachment: UserAttachment = {
  name: "report.pdf",
  mediaType: "application/pdf",
  sizeBytes: 123,
  file: { rolloutId: "session_1", path: "attachments/staging/draft_1/2.pdf" },
}

function register(attachments: readonly UserAttachment[] = [attachment]) {
  const webContents = { mainFrame: {} }
  const trustedWindow = {
    isDestroyed: vi.fn(() => false),
    webContents,
    once: vi.fn<(event: string, listener: () => void) => void>(),
  }
  const request = vi.fn(async (command: ServerControlCommand) => {
    if (command.type === "import_attachment_paths") {
      return { requestId: "request_test", ok: true as const, attachments }
    }
    if (command.type === "discard_draft_attachments")
      return { requestId: "request_test", ok: true as const }
    throw new Error(`Unexpected server command: ${command.type}`)
  })
  registerAttachmentImporter(
    {
      url: "http://127.0.0.1:4141",
      request,
    } as unknown as ServerProcess,
    trustedWindow as never,
  )
  return {
    event: {
      sender: webContents,
      senderFrame: webContents.mainFrame,
    },
    request,
    trustedWindow,
  }
}

function handler(channel: string): IpcHandler {
  const registered = electron.handlers.get(channel)
  if (registered === undefined) {
    throw new Error(`Missing IPC handler: ${channel}`)
  }
  return registered
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "yakitori-attachment-importer-"),
  )
  temporaryDirectories.push(directory)
  return directory
}
