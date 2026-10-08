import { assetSourceKey } from "../core/asset-types.ts"
import type { InputDraft } from "../core/user-input.ts"
import { inputContentAttachments } from "../core/user-input.ts"
import type { InputContent, UserAttachment } from "../kernel/events.ts"

// Editor Undo steps can outlive staging files. This renderer-local ownership
// map resolves those references to the server's promoted assets; it never
// changes authored text or markers or crosses API origins.
export function createInputAttachmentOwnership() {
  const promoted = new Map<string, UserAttachment["file"]>()
  const key = (apiBase: string, image: UserAttachment) => {
    const base = new URL(apiBase)
    base.hash = ""
    base.search = ""
    if (!base.pathname.endsWith("/")) base.pathname += "/"
    return `${base.toString()}\0${assetSourceKey(image.file)}`
  }
  const resolve = (apiBase: string, image: UserAttachment): UserAttachment => {
    const file = promoted.get(key(apiBase, image))
    return file === undefined ? image : { ...image, file: { ...file } }
  }

  return {
    resolve,
    resolveDraft(apiBase: string, draft: InputDraft): InputDraft {
      return {
        ...draft,
        attachments: draft.attachments.map((attachment) =>
          resolve(apiBase, attachment),
        ),
      }
    },
    promote(
      apiBase: string,
      original: InputContent,
      accepted: InputContent,
    ): void {
      if (
        original.text !== accepted.text ||
        JSON.stringify(original.elements) !==
          JSON.stringify(accepted.elements) ||
        original.attachments.length !== accepted.attachments.length ||
        original.attachments.some((attachment, index) => {
          const other = accepted.attachments[index]
          return (
            other?.name !== attachment.name ||
            other.mediaType !== attachment.mediaType ||
            other.sizeBytes !== attachment.sizeBytes
          )
        })
      )
        throw new Error("Promoted input does not match submitted content.")
      const originals = inputContentAttachments(original)
      const acceptedImages = inputContentAttachments(accepted)
      const updates: [string, UserAttachment["file"]][] = []
      for (const [index, image] of originals.entries()) {
        // Durable history references keep their original owner. Only staging
        // paths disappear after admission and need an editor-history alias.
        if (
          "url" in image.file ||
          !image.file.path.startsWith("attachments/staging/")
        )
          continue
        const target = acceptedImages[index]
        if (target === undefined) throw new Error("Missing promoted image.")
        if (
          "url" in target.file ||
          target.file.path.startsWith("attachments/staging/")
        )
          throw new Error("Admission did not promote the staged image.")
        const sourceKey = key(apiBase, image)
        if (sourceKey !== key(apiBase, target))
          updates.push([sourceKey, { ...target.file }])
      }
      for (const [source, file] of updates) promoted.set(source, file)
    },
  }
}

export const inputAttachmentOwnership = createInputAttachmentOwnership()
