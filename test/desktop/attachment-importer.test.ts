import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerAttachmentImporter } from "../../src/desktop/attachment-importer.ts"
import type { ServerProcess } from "../../src/desktop/server-process.ts"
import type { ImageAttachment } from "../../src/kernel/events.ts"

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
    createFromPath: vi.fn(() => ({ isEmpty: () => false })),
    createFromBuffer: vi.fn(() => ({ isEmpty: () => false })),
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
  electron.createFromBuffer.mockClear()
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
      handler("yakitori:pick-images")(event),
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

    const selection = (await handler("yakitori:pick-images")(event)) as {
      readonly selectionId: string
    }
    expect(selection).toEqual({
      selectionId: expect.stringMatching(/^image_selection_/),
    })
    expect(selection).not.toHaveProperty("filePaths")

    await expect(
      handler("yakitori:import-picked-images")(event, {
        sessionId: "session_1",
        selectionId: selection.selectionId,
      }),
    ).resolves.toEqual([attachment])
    expect(request).toHaveBeenCalledWith({
      type: "import_image_paths",
      sessionId: "session_1",
      ownerId: expect.stringMatching(/^draft_/),
      paths: [imagePath],
    })
    await expect(
      handler("yakitori:import-picked-images")(event, {
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
    const selection = (await handler("yakitori:pick-images")(event)) as {
      readonly selectionId: string
    }

    await handler("yakitori:discard-picked-images")(event, selection)

    await expect(
      handler("yakitori:import-picked-images")(event, {
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
    const selection = (await handler("yakitori:pick-images")(event)) as {
      readonly selectionId: string
    }

    await handler("yakitori:import-picked-images")(event, {
      selectionId: selection.selectionId,
    })

    expect(request).toHaveBeenCalledWith({
      type: "import_image_paths",
      rolloutId: expect.stringMatching(/^draft_[0-9a-f]+$/),
      ownerId: expect.stringMatching(/^draft_/),
      paths: [imagePath],
    })
  })
})

const attachment: ImageAttachment = {
  name: "shot.png",
  mediaType: "image/png",
  detail: "high",
  sizeBytes: 3,
  file: {
    rolloutId: "session_1",
    path: "attachments/staging/draft_1/1.png",
  },
}

function register() {
  const webContents = { mainFrame: {} }
  const trustedWindow = {
    isDestroyed: () => false,
    webContents,
    once: vi.fn(),
  }
  const request = vi.fn(async (command: { readonly type: string }) => {
    if (command.type === "import_image_paths") {
      return { ok: true as const, attachments: [attachment] }
    }
    if (command.type === "discard_draft_images") return { ok: true as const }
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
