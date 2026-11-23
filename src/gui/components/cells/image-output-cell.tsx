import type { ModelImageBlock } from "../../../protocol/conversation.ts"
import { rolloutAssetUrl } from "../../rollout-asset-url.ts"

export function ImageOutputCell({
  image,
  apiBase,
  label = "Generated image",
}: Readonly<{
  image: ModelImageBlock
  apiBase: string
  label?: string | undefined
}>) {
  const src =
    image.file === undefined
      ? `data:${image.mediaType};base64,${image.data}`
      : rolloutAssetUrl(image.file, apiBase)
  return src === undefined ? null : (
    <img
      src={src}
      alt={image.file === undefined ? label : (image.name ?? label)}
      loading="lazy"
      className="max-h-96 max-w-full rounded object-contain"
    />
  )
}
