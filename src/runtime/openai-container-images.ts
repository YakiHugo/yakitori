import OpenAI from "openai"
import type { Response as ModelResponse } from "openai/resources/responses/responses"
import {
  InvalidImageDataError,
  inspectImageBytes,
} from "../kernel/image-metadata.ts"
import { ATTACHMENT_FILE_SAFETY_BYTES } from "../protocol/attachment-upload.ts"
import type { ModelImageOutputBlock } from "../protocol/conversation.ts"

// Bound work even when a provider repeats references or returns broken files.
const maxContainerFileLookups = 16

export function createContainerImageReader(
  client: OpenAI,
  turnSignal?: AbortSignal,
) {
  const byItem = new Map<string, readonly ModelImageOutputBlock[]>()
  const attempted = new Set<string>()
  let remainingBytes = ATTACHMENT_FILE_SAFETY_BYTES
  return {
    byItem,
    async load(item: ModelResponse["output"][number]) {
      if (
        (item.type !== "message" && item.type !== "code_interpreter_call") ||
        byItem.has(item.id)
      )
        return
      const images: ModelImageOutputBlock[] = []
      byItem.set(item.id, images)
      const add = (bytes: Buffer) => {
        if (bytes.length > remainingBytes) return
        remainingBytes -= bytes.length
        try {
          const { mediaType } = inspectImageBytes(bytes)
          images.push({
            type: "image_output",
            image: { type: "image", mediaType, data: bytes.toString("base64") },
          })
        } catch (error) {
          if (!(error instanceof InvalidImageDataError)) throw error
        }
      }
      if (item.type === "code_interpreter_call") {
        for (const result of item.outputs ?? []) {
          if (result.type !== "image") continue
          const match =
            /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(
              result.url,
            )
          const data = match?.[1]
          if (
            data !== undefined &&
            data.length <= Math.ceil(remainingBytes / 3) * 4
          )
            add(Buffer.from(data, "base64"))
        }
        return
      }
      for (const part of item.content) {
        if (part.type !== "output_text") continue
        for (const annotation of part.annotations ?? []) {
          if (
            annotation.type !== "container_file_citation" ||
            typeof annotation.filename !== "string" ||
            !/\.(?:png|jpe?g|gif|webp)$/iu.test(annotation.filename) ||
            typeof annotation.container_id !== "string" ||
            !/^[\w-]+$/u.test(annotation.container_id) ||
            typeof annotation.file_id !== "string" ||
            !/^[\w-]+$/u.test(annotation.file_id)
          )
            continue
          if (attempted.size >= maxContainerFileLookups || remainingBytes === 0)
            return
          const key = JSON.stringify([
            annotation.container_id,
            annotation.file_id,
          ])
          if (attempted.has(key)) continue
          attempted.add(key)
          const signal = AbortSignal.any([
            AbortSignal.timeout(10_000),
            ...(turnSignal === undefined ? [] : [turnSignal]),
          ])
          try {
            const response = await client.containers.files.content.retrieve(
              annotation.file_id,
              { container_id: annotation.container_id },
              { signal, maxRetries: 0 },
            )
            const bytes = await readImageBytes(response, remainingBytes)
            if (bytes !== undefined) add(bytes)
          } catch (error) {
            turnSignal?.throwIfAborted()
            // The file can expire independently of a valid assistant answer.
            if (
              !(
                error instanceof OpenAI.APIError ||
                error instanceof TypeError ||
                signal.aborted
              )
            )
              throw error
          }
        }
      }
    },
  }
}

async function readImageBytes(
  response: Response,
  limit: number,
): Promise<Buffer | undefined> {
  if (response.body === null) return
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body.cancel()
    return
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) return Buffer.concat(chunks, bytes)
      bytes += result.value.length
      if (bytes > limit) {
        await reader.cancel()
        return
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
}
