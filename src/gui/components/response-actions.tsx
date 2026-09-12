import { Check, Copy } from "lucide-react"
import { useEffect, useRef, useState } from "react"

export function ResponseActions({
  text,
  at,
}: Readonly<{ text: string; at: string }>) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string>()
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(reset.current), [])
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <button
        type="button"
        aria-label={copied ? "Copied response" : "Copy response"}
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
            setError(
              "Could not copy. Select the response and copy it manually.",
            )
          }
        }}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </button>
      <time dateTime={at} title={new Date(at).toLocaleString()}>
        {new Date(at).toLocaleString([], {
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
        })}
      </time>
      {error ? <span role="status">{error}</span> : null}
    </div>
  )
}
