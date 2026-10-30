import { createCanvas } from "@napi-rs/canvas"
import type {
  ComputerPreviewCatalog,
  ComputerPreviewFrame,
} from "../../src/protocol/computer-preview.ts"

export const computerPreviewCatalog: ComputerPreviewCatalog = {
  targets: [
    {
      id: "owned-window",
      label: "Owned fixture window",
      target: { scope: "window", pid: 123456, launchTime: 1000, windowId: 101 },
    },
  ],
}

export function computerPreviewFrame(): ComputerPreviewFrame {
  const canvas = createCanvas(200, 100)
  const context = canvas.getContext("2d")
  context.fillStyle = "#123456"
  context.fillRect(0, 0, 200, 100)
  return {
    dataUrl: canvas.toDataURL("image/png"),
    width: 200,
    height: 100,
    frame: { x: 10, y: 20, width: 100, height: 50 },
    pointer: { x: 30, y: 35 },
    receivedAt: "2026-10-30T15:00:00.000Z",
  }
}
