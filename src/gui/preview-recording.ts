import type { ComputerPreviewFrame } from "../protocol/computer-preview.ts"

// Stop at a chunk boundary around 64 MiB to bound an open renderer's recording
// memory. This is an implementation safety threshold, not a recording quota.
const stopAtBytes = 64 * 1024 * 1024

export class PreviewRecording {
  readonly finished: Promise<{ blob: Blob; reason: "stopped" | "size" }>
  readonly #completion = Promise.withResolvers<{
    blob: Blob
    reason: "stopped" | "size"
  }>()
  readonly #canvas: HTMLCanvasElement
  readonly #drawing: CanvasRenderingContext2D
  readonly #stream: MediaStream
  readonly #track: CanvasCaptureMediaStreamTrack
  readonly #recorder: MediaRecorder
  #pending = Promise.resolve()
  #next: ComputerPreviewFrame | undefined
  #drawingPending = false
  #chunks: Blob[] = []
  #bytes = 0
  #stopping = false
  #failure: unknown
  #reason: "stopped" | "size" = "stopped"

  constructor(frame: ComputerPreviewFrame) {
    this.finished = this.#completion.promise
    this.#canvas = document.createElement("canvas")
    this.#canvas.width = frame.width
    this.#canvas.height = frame.height
    const drawing = this.#canvas.getContext("2d")
    if (!drawing) throw new Error("Canvas recording is unavailable.")
    this.#drawing = drawing
    this.#stream = this.#canvas.captureStream(0)
    const track = this.#stream.getVideoTracks()[0]
    if (!track || !("requestFrame" in track)) {
      for (const track of this.#stream.getTracks()) track.stop()
      throw new Error("Preview frame recording is unavailable.")
    }
    this.#track = track as CanvasCaptureMediaStreamTrack
    try {
      const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8"].find(
        (type) => MediaRecorder.isTypeSupported(type),
      )
      if (!mimeType) throw new Error("WebM recording is unavailable.")
      this.#recorder = new MediaRecorder(this.#stream, {
        mimeType,
        videoBitsPerSecond: 1_000_000,
      })
      this.#recorder.ondataavailable = ({ data }) => {
        if (data.size) {
          this.#chunks.push(data)
          this.#bytes += data.size
        }
        if (this.#bytes >= stopAtBytes && !this.#stopping) {
          this.#reason = "size"
          void this.stop()
        }
      }
      this.#recorder.onerror = (event) => {
        this.#failure = new Error(`Preview encoding failed (${event.type}).`)
        void this.stop()
      }
      this.#recorder.onstop = () => {
        for (const track of this.#stream.getTracks()) track.stop()
        if (this.#failure) this.#completion.reject(this.#failure)
        else if (!this.#bytes)
          this.#completion.reject(new Error("No preview video was encoded."))
        else
          this.#completion.resolve({
            blob: new Blob(this.#chunks, { type: "video/webm" }),
            reason: this.#reason,
          })
        this.#chunks = []
      }
      this.#recorder.start(1000)
    } catch (cause) {
      for (const track of this.#stream.getTracks()) track.stop()
      throw cause
    }
  }

  append(frame: ComputerPreviewFrame): void {
    if (this.#stopping) return
    this.#next = frame
    if (this.#drawingPending) return
    this.#drawingPending = true
    this.#pending = Promise.resolve()
      .then(async () => {
        while (this.#next && !this.#stopping) {
          const frame = this.#next
          this.#next = undefined
          const response = await fetch(frame.dataUrl)
          const bitmap = await createImageBitmap(await response.blob())
          try {
            if (this.#stopping) return
            if (bitmap.width !== frame.width || bitmap.height !== frame.height)
              throw new Error(
                "Preview frame dimensions do not match its pixels.",
              )
            const canvas = this.#canvas,
              drawing = this.#drawing,
              scale = Math.min(
                canvas.width / bitmap.width,
                canvas.height / bitmap.height,
              ),
              width = bitmap.width * scale,
              height = bitmap.height * scale,
              left = (canvas.width - width) / 2,
              top = (canvas.height - height) / 2
            drawing.fillStyle = "black"
            drawing.fillRect(0, 0, canvas.width, canvas.height)
            drawing.drawImage(bitmap, left, top, width, height)
            const pointer = frame.pointer
            if (
              pointer &&
              frame.frame.width > 0 &&
              frame.frame.height > 0 &&
              pointer.x >= frame.frame.x &&
              pointer.x < frame.frame.x + frame.frame.width &&
              pointer.y >= frame.frame.y &&
              pointer.y < frame.frame.y + frame.frame.height
            ) {
              const x =
                  left +
                  ((pointer.x - frame.frame.x) / frame.frame.width) * width,
                y =
                  top +
                  ((pointer.y - frame.frame.y) / frame.frame.height) * height
              drawing.beginPath()
              drawing.arc(x, y, 5, 0, 2 * Math.PI)
              drawing.fillStyle = "white"
              drawing.fill()
              drawing.lineWidth = 2
              drawing.strokeStyle = "black"
              drawing.stroke()
            }
            this.#track.requestFrame()
          } finally {
            bitmap.close()
          }
        }
      })
      .catch((cause: unknown) => {
        this.#failure = cause
        this.#stopping = true
        if (this.#recorder.state !== "inactive") this.#recorder.stop()
      })
      .finally(() => {
        this.#drawingPending = false
      })
  }

  stop(): Promise<{ blob: Blob; reason: "stopped" | "size" }> {
    if (!this.#stopping) {
      this.#stopping = true
      this.#next = undefined
      void this.#pending.then(() => {
        if (this.#recorder.state !== "inactive") this.#recorder.stop()
      })
    }
    return this.finished
  }
}
