import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { describe, expect, it, vi } from "vitest"

const preload = readFileSync(
  new URL("../../src/desktop/preload.cjs", import.meta.url),
  "utf8",
)

describe("desktop attachment preload", () => {
  it("transports pathless PDFs and native image paths in original order", async () => {
    const { bridge, invoke, getPathForFile } = loadPreload()
    const pdf = new File(["%PDF-1.4"], "notes.pdf", { type: "application/pdf" })
    const image = new File(["image"], "shot.png", { type: "image/png" })
    getPathForFile.mockImplementation((file: File) =>
      file === image ? "/selected/shot.png" : "",
    )
    const readNativeFile = vi.spyOn(image, "arrayBuffer")

    await bridge.importAttachmentFiles({ files: [pdf, image] })

    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      "yakitori:import-attachment-files",
      {
        items: [
          { name: "notes.pdf", data: new Uint8Array(Buffer.from("%PDF-1.4")) },
          { name: "shot.png", filePath: "/selected/shot.png" },
        ],
      },
    )
    expect(readNativeFile).not.toHaveBeenCalled()
  })

  it("rejects oversized pathless files before reading or invoking main IPC", async () => {
    const { bridge, invoke } = loadPreload()
    const pdf = new File([], "large.pdf", { type: "application/pdf" })
    Object.defineProperty(pdf, "size", { value: 50_000_001 })
    const readFile = vi.spyOn(pdf, "arrayBuffer")

    await expect(
      bridge.importAttachmentFiles({ files: [pdf] }),
    ).rejects.toThrow("50 MB")
    expect(readFile).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })

  it("exposes the generic picker, single-use selection and cleanup contract", async () => {
    const { bridge, invoke } = loadPreload()
    await bridge.pickAttachments()
    await bridge.importPickedAttachments({
      selectionId: "selection_1",
      sessionId: "session_1",
    })
    await bridge.discardPickedAttachments({ selectionId: "selection_2" })
    await bridge.discardDraftAttachments([])
    expect(invoke.mock.calls).toEqual([
      ["yakitori:pick-attachments"],
      [
        "yakitori:import-picked-attachments",
        { selectionId: "selection_1", sessionId: "session_1" },
      ],
      ["yakitori:discard-picked-attachments", { selectionId: "selection_2" }],
      ["yakitori:discard-draft-attachments", []],
    ])
    expect(bridge).not.toHaveProperty("pickImages")
  })
})

function loadPreload() {
  let bridge: YakitoriDesktopBridge | undefined
  const invoke = vi.fn(async () => undefined)
  const getPathForFile = vi.fn((_file: File) => "")
  runInNewContext(preload, {
    process: { platform: "test" },
    Uint8Array,
    require: (name: string) => {
      if (name !== "electron")
        throw new Error(`Unexpected preload import: ${name}`)
      return {
        contextBridge: {
          exposeInMainWorld: (
            _name: string,
            exposed: YakitoriDesktopBridge,
          ) => {
            bridge = exposed
          },
        },
        ipcRenderer: { invoke },
        webUtils: { getPathForFile },
      }
    },
  })
  if (bridge === undefined) throw new Error("Preload did not expose its bridge")
  return { bridge, invoke, getPathForFile }
}
