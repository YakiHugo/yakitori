import { Check, Copy } from "lucide-react"
import { useEffect, useRef, useState } from "react"

export function CopyIconButton({
  text,
  label,
}: Readonly<{ text: string; label: string }>) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string>()
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(reset.current), [])
  return (
    <>
      <button
        type="button"
        aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
        title={copied ? "Copied" : `Copy ${label}`}
        className="rounded-md p-1 transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text)
            setError(undefined)
            setCopied(true)
            clearTimeout(reset.current)
            reset.current = setTimeout(() => setCopied(false), 1500)
          } catch (error) {
            if (!(error instanceof DOMException)) throw error
            setError("Could not copy. Select the text and copy it manually.")
          }
        }}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </button>
      {error ? <span role="status">{error}</span> : null}
    </>
  )
}

export function MessageTimestamp({ at }: Readonly<{ at: string }>) {
  return (
    <time dateTime={at} title={new Date(at).toLocaleString()}>
      {new Date(at).toLocaleString([], {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      })}
    </time>
  )
}

export function ResponseActions({
  text,
  at,
}: Readonly<{ text: string; at: string }>) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <CopyIconButton text={text} label="response" />
      <MessageTimestamp at={at} />
    </div>
  )
}
