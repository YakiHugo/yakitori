import { inspectImageBytes } from "../kernel/image-metadata.ts"
import {
  BrowserControlError,
  type DesktopBrowser,
  parseBrowserCaptureRequest,
} from "../protocol/desktop-browser.ts"
import { mediaPresentation } from "../runtime/tools/result-output.ts"
import type { RuntimeTool } from "../runtime/tools/types.ts"
import { browserDataText, browserModelResult } from "./browser-tool-target.ts"

export function createBrowserScreenshot(
  browser: DesktopBrowser,
): Pick<RuntimeTool, "execute"> {
  return {
    async execute(input, context) {
      context.signal?.throwIfAborted()
      try {
        const request = parseBrowserCaptureRequest(input)
        if (context.documentReading?.images !== true)
          throw new BrowserControlError(
            "unsupported_model",
            "Browser screenshots require an image-capable model. Use browser_inspect snapshot for accessibility text.",
          )
        const { rolloutAssets, rolloutId, toolCallId } = context
        if (!rolloutAssets || !rolloutId || !toolCallId)
          throw new Error("Browser screenshots require rollout asset storage.")
        if (!context.threadId || !context.turnId)
          throw new Error(
            "Browser captures require an owning session and turn.",
          )
        const result = await browser.request(
          request,
          { sessionId: context.threadId, turnId: context.turnId },
          context.signal,
        )
        context.signal?.throwIfAborted()
        const { imageBase64, ...receipt } = result
        if (
          typeof imageBase64 !== "string" ||
          imageBase64.length > 480_000 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)
        )
          throw new Error("Invalid browser screenshot transport data.")
        const bytes = Buffer.from(imageBase64, "base64"),
          metadata = inspectImageBytes(bytes)
        if (
          metadata.mediaType !== "image/jpeg" ||
          metadata.width > 1600 ||
          metadata.height > 1600
        )
          throw new Error("Invalid browser screenshot image metadata.")
        const saved = await rolloutAssets.saveToolFile(
          rolloutId,
          toolCallId,
          "browser.jpg",
          bytes,
        )
        const output = {
            ...browserModelResult(receipt),
            ...metadata,
            sizeBytes: bytes.length,
            file: saved.reference,
          },
          content = browserDataText(
            "browser-screenshot",
            JSON.stringify(output),
          )
        return {
          ok: true,
          output,
          content,
          presentation: mediaPresentation({
            content: [
              { type: "text", text: content },
              {
                type: "image",
                mediaType: metadata.mediaType,
                detail: "high",
                sizeBytes: bytes.length,
                file: saved.reference,
              },
            ],
          }),
        }
      } catch (cause) {
        if (!(cause instanceof BrowserControlError)) throw cause
        return {
          ok: false,
          code: cause.code,
          message: cause.message,
          content: cause.message,
        }
      }
    },
  }
}
