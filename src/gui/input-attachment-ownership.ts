import type {
  UserAttachment,
  InputContent,
  InputPart,
} from "../kernel/events.ts"
import { inputContentAttachments } from "../kernel/input-content.ts"

// Editor Undo steps can outlive staging files. This renderer-local ownership
// map resolves those references to the server's promoted assets; it never
// changes authored parts or crosses API origins.
export function createInputAttachmentOwnership() {
  const promoted = new Map<string, UserAttachment["file"]>()
  const key = (apiBase: string, image: UserAttachment) => {
    const base = new URL(apiBase)
    base.hash = ""
    base.search = ""
    if (!base.pathname.endsWith("/")) base.pathname += "/"
    return `${base.toString()}\0${image.file.rolloutId}\0${image.file.path}`
  }
  const resolve = (apiBase: string, image: UserAttachment): UserAttachment => {
    const file = promoted.get(key(apiBase, image))
    return file === undefined ? image : { ...image, file: { ...file } }
  }

  return {
    resolve,
    resolveParts(
      apiBase: string,
      parts: readonly InputPart[],
    ): readonly InputPart[] {
      return parts.map((part) => {
        if (part.type === "text") return part
        const attachment = resolve(apiBase, part)
        return attachment.mediaType === "application/pdf"
          ? { ...attachment, type: "document" }
          : { ...attachment, type: "image" }
      })
    },
    promote(
      apiBase: string,
      original: InputContent,
      accepted: InputContent,
    ): void {
      if (
        original.parts.length !== accepted.parts.length ||
        original.parts.some((part, index) => {
          const other = accepted.parts[index]
          return part.type === "text"
            ? other?.type !== "text" || part.text !== other.text
            : other?.type !== part.type ||
                part.name !== other.name ||
                part.mediaType !== other.mediaType ||
                part.sizeBytes !== other.sizeBytes
        })
      )
        throw new Error("Promoted input does not match submitted content.")
      const originals = inputContentAttachments(original)
      const acceptedImages = inputContentAttachments(accepted)
      const updates: [string, UserAttachment["file"]][] = []
      for (const [index, image] of originals.entries()) {
        // Durable history references keep their original owner. Only staging
        // paths disappear after admission and need an editor-history alias.
        if (!image.file.path.startsWith("attachments/staging/")) continue
        const target = acceptedImages[index]
        if (target === undefined) throw new Error("Missing promoted image.")
        if (target.file.path.startsWith("attachments/staging/"))
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
