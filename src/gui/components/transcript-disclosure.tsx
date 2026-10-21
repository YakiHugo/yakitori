import { type ReactNode, useState } from "react"

// Transcript content can contain expensive Markdown and diff trees. Mount it
// on first use, then hide it without replaying layout animations or discarding
// nested disclosure state on every click.
export function TranscriptDisclosureContent({
  id,
  open,
  className,
  children,
}: Readonly<{
  id: string
  open: boolean
  className?: string
  children: ReactNode
}>) {
  const [rendered, setRendered] = useState(() => (open ? children : null))
  // Keep the last visible tree while closed: stream deltas should not parse
  // hidden Markdown. Reopening reconciles it with the latest content.
  if (open && rendered !== children) setRendered(children)
  return (
    <div id={id} className={className} hidden={!open} aria-hidden={!open}>
      {rendered}
    </div>
  )
}
