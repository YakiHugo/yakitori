import { createHash } from "node:crypto"
import type { ModelDocumentBlock } from "./model.ts"

// The caller owns this cache with its authenticated client. IDs must never be
// shared with another endpoint/account or persisted as conversation sources.
export function createFileUploadCache(
  upload: (
    document: ModelDocumentBlock,
    bytes: Buffer,
    signal?: AbortSignal,
  ) => Promise<string>,
  remove: (id: string) => Promise<unknown>,
) {
  const files = new Map<string, Promise<string>>()
  const prepare = (
    document: ModelDocumentBlock,
    bytes: Buffer,
    signal?: AbortSignal,
  ): Promise<string> => {
    const key = `${document.name}\0${createHash("sha256").update(bytes).digest("hex")}`
    const existing = files.get(key)
    if (existing) return existing
    const pending = upload(document, bytes, signal)
    files.set(key, pending)
    // Failed and aborted uploads have no reusable file ID. Propagate the failure
    // to every waiter and let the next model attempt upload again.
    void pending.catch(() => {
      if (files.get(key) === pending) files.delete(key)
    })
    return pending
  }
  return Object.assign(prepare, {
    async close(): Promise<void> {
      const results = await Promise.allSettled(files.values())
      files.clear()
      const ids = new Set(
        results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        ),
      )
      const removed = await Promise.allSettled([...ids].map(remove))
      const failures = removed.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      )
      if (failures.length)
        throw new AggregateError(
          failures,
          "Failed to remove provider-uploaded files.",
        )
    },
  })
}
