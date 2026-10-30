import {
  type BrowserCaptureRequest,
  BrowserControlError,
} from "../protocol/desktop-browser.ts"
import type { JsonObject } from "../protocol/events.ts"

export async function captureBrowserPage(
  input: BrowserCaptureRequest,
  command: (
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<unknown>,
  zoom: number,
): Promise<JsonObject> {
  const object = (value: unknown): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("Chromium returned invalid screenshot data.")
    return value as Record<string, unknown>
  }
  const metrics = object(await command("Page.getLayoutMetrics")),
    content = object(metrics.cssContentSize),
    viewport = object(metrics.cssVisualViewport)
  const rectangle =
    input.mode === "clip"
      ? input.clip
      : input.mode === "page"
        ? {
            x: content.x,
            y: content.y,
            width: content.width,
            height: content.height,
          }
        : {
            x: viewport.pageX,
            y: viewport.pageY,
            width: viewport.clientWidth,
            height: viewport.clientHeight,
          }
  const { x, y, width, height } = rectangle
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    ![x, y, width, height].every(Number.isFinite) ||
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0
  )
    throw new Error("Chromium returned no valid screenshot rectangle.")
  // Bound offscreen renderer paint and host image decoding, independently of
  // model/provider image quotas. Large pages can be captured in explicit clips.
  if (
    width * height > 16_000_000 ||
    typeof content.width !== "number" ||
    typeof content.height !== "number" ||
    x + width > content.width ||
    y + height > content.height
  )
    throw new BrowserControlError(
      "browser_capture_size",
      "The screenshot is outside the document or exceeds the 16 megapixel source paint safety bound. Use a smaller clip.",
    )
  if (!Number.isFinite(zoom) || zoom <= 0)
    throw new Error("Invalid browser capture zoom factor.")
  // Page.captureScreenshot clips use DIP, while layout metrics and the public
  // request use CSS pixels. Page zoom is separate from Retina device scale.
  const scale = Math.min(1, 1600 / (Math.max(width, height) * zoom))
  const captured = object(
    await command("Page.captureScreenshot", {
      format: "jpeg",
      quality: 80,
      fromSurface: true,
      captureBeyondViewport: true,
      clip: {
        x: x * zoom,
        y: y * zoom,
        width: width * zoom,
        height: height * zoom,
        scale,
      },
    }),
  )
  if (
    typeof captured.data !== "string" ||
    captured.data.length > 32_000_000 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(captured.data)
  )
    throw new Error("Chromium returned an invalid or oversized screenshot.")
  const { default: sharp } = await import("sharp")
  const image = sharp(Buffer.from(captured.data, "base64"), {
    limitInputPixels: 16_000_000,
  }).resize({
    width: 1600,
    height: 1600,
    fit: "inside",
    withoutEnlargement: true,
  })
  // Re-encode the same captured pixels; never recapture a different instant to
  // satisfy IPC. Leave room for document/target metadata in the 512KiB reply.
  for (const quality of [80, 50, 25]) {
    const encoded = await image
      .clone()
      .jpeg({ quality })
      .toBuffer({ resolveWithObject: true })
    const imageBase64 = encoded.data.toString("base64")
    if (imageBase64.length <= 480_000)
      return {
        imageBase64,
        capture: {
          mode: input.mode,
          zoom,
          source: { x, y, width, height },
          width: encoded.info.width,
          height: encoded.info.height,
          mimeType: "image/jpeg",
          quality,
        },
      }
  }
  throw new BrowserControlError(
    "browser_capture_size",
    "The image exceeds the screenshot IPC safety bound. Use a smaller clip.",
  )
}
