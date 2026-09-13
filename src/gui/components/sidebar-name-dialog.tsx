import { useState } from "react"
import { SidebarDialog } from "./sidebar-surfaces.tsx"
import { Button } from "./ui/button.tsx"

export function SidebarNameDialog({
  title,
  initialName = "",
  onSave,
  onClose,
}: Readonly<{
  title: string
  initialName?: string
  onSave(name: string): Promise<boolean>
  onClose(): void
}>) {
  const [name, setName] = useState(initialName)
  const [saving, setSaving] = useState(false)
  return (
    <SidebarDialog title={title} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (saving || !name.trim()) return
          setSaving(true)
          void onSave(name.trim()).then((done) => {
            setSaving(false)
            if (done) onClose()
          })
        }}
      >
        <input
          aria-label="Name"
          data-autofocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="h-10 w-full rounded-lg border bg-transparent px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving || !name.trim()}>
            Save
          </Button>
        </div>
      </form>
    </SidebarDialog>
  )
}
