import type { ModelImageBlock } from "../../../protocol/conversation.ts"
import { rolloutAssetUrl } from "../../rollout-asset-url.ts"

export function ImageOutputCell({
  image,
  apiBase,
}: Readonly<{ image: ModelImageBlock; apiBase: string }>) {
  const src =
    image.file === undefined
      ? `data:${image.mediaType};base64,${image.data}`
      : rolloutAssetUrl(image.file, apiBase)
  return src === undefined ? null : (
    <img
      src={src}
      alt={
        image.file === undefined
          ? "Generated image"
          : (image.name ?? "Generated image")
      }
      loading="lazy"
      className="max-h-96 max-w-full rounded object-contain"
    />
  )
}
