import { useTranslation } from "../i18n/use-translation.ts"
import type { Message } from "../i18n/messages.ts"
import { Check, Copy } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { writeClipboardText } from "../lib/clipboard.ts"

export function CopyIconButton({
  text,
  label,
}: Readonly<{ text: string; label: Message }>) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string>()
  const [copying, setCopying] = useState(false)
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(reset.current), [])
  return (
    <>
      <button
        type="button"
        aria-label={
          copied ? t("Copied {0}", t(label)) : t("Copy {0}", t(label))
        }
        title={copied ? t("Copied") : t("Copy {0}", t(label))}
        disabled={copying}
        className="rounded-md p-1 transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={async () => {
          setCopying(true)
          setCopied(false)
          setError(undefined)
          clearTimeout(reset.current)
          try {
            await writeClipboardText(text)
            setCopied(true)
            clearTimeout(reset.current)
            reset.current = setTimeout(() => setCopied(false), 1500)
          } catch {
            setError(t("Could not copy. Select the text and copy it manually."))
          } finally {
            setCopying(false)
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
  const { locale } = useTranslation()
  return (
    <time dateTime={at} title={new Date(at).toLocaleString(locale)}>
      {new Date(at).toLocaleString(locale, {
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
    <div className="message-actions">
      <CopyIconButton text={text} label="response" />
      <MessageTimestamp at={at} />
    </div>
  )
}
