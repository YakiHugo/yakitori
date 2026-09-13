import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"
import { Check, ChevronRight, MoreHorizontal, X } from "lucide-react"

export function SidebarDialog({
  title,
  onClose,
  children,
  dismissible = true,
  className,
}: Readonly<{
  title: string
  onClose(): void
  children: ReactNode
  dismissible?: boolean
  className?: string
}>) {
  const ref = useRef<HTMLDialogElement>(null)
  const [closing, setClosing] = useState(false)
  const closeCallback = useRef(onClose)
  useLayoutEffect(() => {
    closeCallback.current = onClose
  }, [onClose])
  useEffect(() => {
    if (!closing) return
    const timer = window.setTimeout(
      () => closeCallback.current(),
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 100,
    )
    return () => window.clearTimeout(timer)
  }, [closing])
  const close = () => {
    if (dismissible) setClosing(true)
  }
  useEffect(() => {
    const previous = document.activeElement
    const dialog = ref.current
    dialog?.showModal()
    dialog?.querySelector<HTMLElement>("[data-autofocus]")?.focus()
    return () => {
      dialog?.close()
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus()
    }
  }, [])
  return createPortal(
    <dialog
      ref={ref}
      aria-label={title}
      className={["sidebar-dialog", className].filter(Boolean).join(" ")}
      data-closing={closing}
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault()
          close()
        }
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return
        const rect = event.currentTarget.getBoundingClientRect()
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          close()
      }}
    >
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        <button
          type="button"
          aria-label="Close"
          disabled={!dismissible}
          className="sidebar-icon"
          onClick={close}
        >
          <X size={16} />
        </button>
      </div>
      {children}
    </dialog>,
    document.body,
  )
}

type MenuAction = Readonly<{
  label: string
  icon?: ReactNode
  destructive?: boolean
  checked?: boolean
  separatorBefore?: boolean
  action(): void
}>
type MenuItem =
  | MenuAction
  | Readonly<{
      label: string
      icon?: ReactNode
      separatorBefore?: boolean
      items: readonly MenuAction[]
    }>

export function SidebarMenu({
  label,
  items,
  children,
  triggerContent,
}: Readonly<{
  label: string
  triggerContent?: ReactNode
  items: readonly MenuItem[]
  children: ReactNode
}>) {
  const owner = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<{ x: number; y: number }>()
  const [closing, setClosing] = useState(false)
  const [submenu, setSubmenu] = useState<{
    item: Extract<MenuItem, { items: readonly MenuAction[] }>
    trigger: HTMLButtonElement
    keyboard: boolean
  }>()
  const close = (restoreFocus = true) => {
    setSubmenu(undefined)
    setClosing(true)
    if (restoreFocus) trigger.current?.focus()
  }
  useEffect(() => {
    if (!closing) return
    const timer = window.setTimeout(
      () => {
        setAnchor(undefined)
        setClosing(false)
      },
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 90,
    )
    return () => window.clearTimeout(timer)
  }, [closing])
  useEffect(() => {
    if (!anchor) return
    const belongsToMenu = (target: EventTarget | null) =>
      target instanceof Element &&
      target.closest<HTMLElement>("[data-menu-owner]")?.dataset.menuOwner ===
        owner
    const outside = (event: PointerEvent) => {
      if (
        !belongsToMenu(event.target) &&
        !(
          event.target instanceof Node &&
          trigger.current?.contains(event.target)
        )
      ) {
        setSubmenu(undefined)
        setClosing(true)
      }
    }
    const dismiss = (event: Event) => {
      if (belongsToMenu(event.target)) return
      setSubmenu(undefined)
      setClosing(true)
    }
    document.addEventListener("pointerdown", outside)
    window.addEventListener("resize", dismiss)
    window.addEventListener("scroll", dismiss, true)
    return () => {
      document.removeEventListener("pointerdown", outside)
      window.removeEventListener("resize", dismiss)
      window.removeEventListener("scroll", dismiss, true)
    }
  }, [anchor, owner])
  return (
    <fieldset
      aria-label={label}
      className="contents"
      onContextMenu={(event) => {
        event.preventDefault()
        setSubmenu(undefined)
        setClosing(false)
        setAnchor({ x: event.clientX, y: event.clientY })
      }}
    >
      {children}
      <button
        ref={trigger}
        type="button"
        className={
          triggerContent ? "sidebar-brand" : "sidebar-icon sidebar-row-action"
        }
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={anchor !== undefined && !closing}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          if (anchor && !closing) close()
          else {
            setClosing(false)
            setAnchor({ x: rect.left, y: rect.bottom + 4 })
          }
        }}
      >
        {triggerContent ?? <MoreHorizontal size={16} />}
      </button>
      {anchor &&
        createPortal(
          <>
            <MenuPanel
              owner={owner}
              label={label}
              items={items}
              anchor={anchor}
              closing={closing}
              focusOnOpen
              onClose={close}
              activeSubmenu={submenu?.item.label}
              onSubmenu={(item, button, keyboard) =>
                setSubmenu(
                  item && button
                    ? { item, trigger: button, keyboard: keyboard ?? false }
                    : undefined,
                )
              }
            />
            {submenu && !closing && (
              <MenuPanel
                key={submenu.item.label}
                owner={owner}
                label={submenu.item.label}
                items={submenu.item.items}
                anchor={{
                  x: submenu.trigger.getBoundingClientRect().right + 5,
                  y: submenu.trigger.getBoundingClientRect().top - 5,
                }}
                parentTrigger={submenu.trigger}
                focusOnOpen={submenu.keyboard}
                closing={false}
                onClose={close}
                onBack={() => {
                  submenu.trigger.focus()
                  setSubmenu(undefined)
                }}
              />
            )}
          </>,
          document.body,
        )}
    </fieldset>
  )
}

function MenuPanel({
  owner,
  label,
  items,
  anchor,
  closing,
  focusOnOpen,
  parentTrigger,
  activeSubmenu,
  onClose,
  onBack,
  onSubmenu,
}: Readonly<{
  owner: string
  label: string
  items: readonly MenuItem[]
  anchor: { x: number; y: number }
  closing: boolean
  focusOnOpen: boolean
  parentTrigger?: HTMLButtonElement
  activeSubmenu?: string | undefined
  onClose(restoreFocus?: boolean): void
  onBack?(): void
  onSubmenu?(
    item?: Extract<MenuItem, { items: readonly MenuAction[] }>,
    button?: HTMLButtonElement,
    keyboard?: boolean,
  ): void
}>) {
  const ref = useRef<HTMLDivElement>(null)
  // Focus only when opening a panel; changing its highlighted row keeps focus.
  useLayoutEffect(() => {
    if (focusOnOpen)
      ref.current?.querySelector<HTMLButtonElement>("button")?.focus()
  }, [focusOnOpen])
  useLayoutEffect(() => {
    const panel = ref.current
    if (!panel) return
    const rect = panel.getBoundingClientRect()
    const x =
      parentTrigger && anchor.x + rect.width > window.innerWidth - 8
        ? (parentTrigger.closest("[role=menu]")?.getBoundingClientRect().left ??
          anchor.x)
        : undefined
    panel.style.left = `${Math.max(8, Math.min(x === undefined ? anchor.x : x - rect.width - 5, window.innerWidth - rect.width - 8))}px`
    panel.style.top = `${Math.max(8, Math.min(anchor.y, window.innerHeight - rect.height - 8))}px`
  }, [anchor.x, anchor.y, parentTrigger])
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      data-menu-owner={owner}
      className="sidebar-menu"
      inert={closing}
      data-closing={closing}
      style={{ left: anchor.x, top: anchor.y }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" && onBack) {
          event.preventDefault()
          onBack()
          return
        }
        if (event.key === "Escape" || event.key === "Tab") {
          event.preventDefault()
          onClose()
          return
        }
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
        ]
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        )
        const next =
          event.key === "ArrowDown"
            ? (index + 1) % buttons.length
            : event.key === "ArrowUp"
              ? (index + buttons.length - 1) % buttons.length
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : undefined
        if (next !== undefined) {
          event.preventDefault()
          buttons[next]?.focus()
        }
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          {...("checked" in item
            ? { role: "menuitemradio", "aria-checked": item.checked }
            : { role: "menuitem" })}
          aria-haspopup={"items" in item ? "menu" : undefined}
          aria-expanded={
            "items" in item ? activeSubmenu === item.label : undefined
          }
          data-submenu-open={activeSubmenu === item.label}
          data-destructive={"destructive" in item && item.destructive}
          data-separator-before={item.separatorBefore}
          onPointerEnter={(event) => {
            if (event.pointerType === "touch") return
            if ("items" in item) onSubmenu?.(item, event.currentTarget, false)
            else onSubmenu?.()
          }}
          onFocus={() => {
            if (!("items" in item)) onSubmenu?.()
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" && "items" in item) {
              event.preventDefault()
              onSubmenu?.(item, event.currentTarget, true)
            }
          }}
          onClick={(event) => {
            if ("items" in item) onSubmenu?.(item, event.currentTarget, true)
            else {
              onClose()
              item.action()
            }
          }}
        >
          <span className="sidebar-menu-icon">
            {"checked" in item
              ? item.checked && <Check size={14} />
              : item.icon}
          </span>
          <span className="flex-1">{item.label}</span>
          {"items" in item && <ChevronRight size={12} />}
        </button>
      ))}
    </div>
  )
}
