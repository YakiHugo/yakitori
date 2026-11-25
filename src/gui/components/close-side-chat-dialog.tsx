import { useTranslation } from "../i18n/use-translation.ts"
import { useEffect, useRef } from "react"

export function CloseSideChatDialog({
  title,
  onConfirm,
  onCancel,
}: Readonly<{
  title: string
  onConfirm(): void
  onCancel(): void
}>) {
  const { t } = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  return (
    <dialog
      ref={dialog}
      className="side-chat-close-dialog"
      aria-labelledby="close-chat-title"
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
    >
      <h2 id="close-chat-title" className="text-base font-semibold">
        {t("Close")} {title}?
      </h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        {t("This temporary chat will be deleted and cannot be recovered.")}
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          className="rounded-lg border px-3 py-2 text-sm"
          onClick={onCancel}
        >
          {t("Cancel")}
        </button>
        <button
          type="button"
          className="rounded-lg bg-destructive px-3 py-2 text-sm text-white"
          onClick={onConfirm}
        >
          {t("Close side chat")}
        </button>
      </div>
    </dialog>
  )
}
