import { useState } from "react"
import { createPortal } from "react-dom"
import { ImageLightbox } from "./image-lightbox.tsx"

export function TranscriptImage({
  src,
  alt,
  title,
  preview = true,
}: Readonly<{
  src: string | undefined
  alt: string
  title?: string | undefined
  preview?: boolean
}>) {
  const [failedSrc, setFailedSrc] = useState<string>()
  const [previewSrc, setPreviewSrc] = useState<string>()
  if (src === undefined || src === failedSrc)
    return (
      <span
        data-find-ignore
        className="inline-flex rounded border px-2 py-1 text-sm text-muted-foreground"
      >
        {alt ? `Image unavailable · ${alt}` : "Image unavailable"}
      </span>
    )

  const name = alt || "image"
  const frame = "inline-block w-fit max-w-[min(100%,15rem)] align-middle"
  const image = (
    <img
      src={src}
      alt={alt}
      title={title}
      loading="lazy"
      decoding="async"
      onError={() => setFailedSrc(src)}
      className="block h-auto max-h-40 max-w-full rounded-lg object-contain"
    />
  )

  return preview ? (
    <>
      <button
        type="button"
        aria-label={`Preview ${name}`}
        aria-haspopup="dialog"
        onClick={() => setPreviewSrc(src)}
        className={`${frame} cursor-zoom-in rounded-lg hover:outline hover:outline-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`}
      >
        {image}
      </button>
      {previewSrc === src
        ? createPortal(
            <ImageLightbox
              src={src}
              name={name}
              onClose={() => setPreviewSrc(undefined)}
            />,
            document.body,
          )
        : null}
    </>
  ) : (
    <span className={frame}>{image}</span>
  )
}
