import { Slice } from "prosemirror-model"
import { baseKeymap, selectAll, splitBlock } from "prosemirror-commands"
import { closeHistory, history, redo, undo } from "prosemirror-history"
import { keymap } from "prosemirror-keymap"
import { EditorState, TextSelection } from "prosemirror-state"
import { EditorView } from "prosemirror-view"
import { type Ref, useImperativeHandle, useLayoutEffect, useRef } from "react"
import {
  parsePrompt,
  promptOffset,
  promptPosition,
  serializePrompt,
} from "./prompt-document.ts"

export type PromptEditorHandle = Readonly<{
  focus(atEnd?: boolean): void
  replaceRange(from: number, to: number, text: string): void
}>

type Props = Readonly<{
  ref?: Ref<PromptEditorHandle>
  value: string
  label: string
  placeholder?: string
  disabled?: boolean
  className?: string
  activeSuggestion?: string | undefined
  menuOpen?: boolean
  onChange(text: string): void
  onSelection?(from: number, to: number): void
  onKeyDown?(event: globalThis.KeyboardEvent): boolean
  onPasteImages?(files: File[]): void
  onFocus?(): void
  onBlur?(): void
}>

// Codex uses ProseMirror for its composer. Keep selection, IME, clipboard and
// undo in the editor transaction boundary; React owns suggestions and submission.
export function PromptEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorView | null>(null)
  const latest = useRef(props)
  useLayoutEffect(() => {
    latest.current = props
  })

  useImperativeHandle(
    props.ref,
    () => ({
      focus(atEnd = false) {
        const view = editor.current
        if (!view) return
        if (atEnd)
          view.dispatch(
            view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)),
          )
        view.focus()
      },
      replaceRange(from, to, text) {
        const view = editor.current
        if (!view) return
        const start = promptPosition(view.state.doc, from)
        const end = promptPosition(view.state.doc, to)
        const content = parsePrompt(text).firstChild?.content
        if (!content) return
        const tr = closeHistory(view.state.tr).replaceWith(start, end, content)
        tr.setSelection(
          TextSelection.near(tr.doc.resolve(start + content.size)),
        )
        view.dispatch(tr.scrollIntoView())
        view.focus()
      },
    }),
    [],
  )

  useLayoutEffect(() => {
    if (!host.current) return
    const doc = parsePrompt(latest.current.value)
    const view = new EditorView(host.current, {
      state: EditorState.create({
        doc,
        selection: TextSelection.atEnd(doc),
        plugins: [
          history(),
          keymap({
            Backspace: (state, dispatch) => {
              const { empty, from, $from } = state.selection
              if (!empty || $from.nodeBefore?.type.name !== "skill")
                return false
              dispatch?.(state.tr.delete(from - 1, from))
              return true
            },
            "Mod-z": undo,
            "Mod-Shift-z": redo,
            "Mod-y": redo,
            "Mod-a": selectAll,
            "Shift-Enter": splitBlock,
          }),
          keymap(baseKeymap),
        ],
      }),
      editable: () => !latest.current.disabled,
      dispatchTransaction(tr) {
        view.updateState(view.state.apply(tr))
        if (tr.docChanged)
          latest.current.onChange(serializePrompt(view.state.doc))
        if (tr.docChanged || tr.selectionSet) {
          const { from, to } = view.state.selection
          latest.current.onSelection?.(
            promptOffset(view.state.doc, from),
            promptOffset(view.state.doc, to),
          )
        }
      },
      handleKeyDown: (view, event) =>
        !view.composing &&
        !event.isComposing &&
        (latest.current.onKeyDown?.(event) ?? false),
      handlePaste: (view, event) => {
        const images = Array.from(event.clipboardData?.files ?? []).filter(
          (file) => file.type.startsWith("image/"),
        )
        if (images.length && latest.current.onPasteImages) {
          latest.current.onPasteImages(images)
          return true
        }
        // Rich clipboard content carries both HTML and text. Choose text here:
        // clearing transformPastedHTML would instead paste an empty HTML slice.
        const text = event.clipboardData?.getData("text/plain")
        if (!text) return false
        view.dispatch(
          view.state.tr
            .replaceSelection(
              new Slice(
                parsePrompt(text.replace(/\r\n?/g, "\n")).content,
                1,
                1,
              ),
            )
            .scrollIntoView()
            .setMeta("paste", true)
            .setMeta("uiEvent", "paste"),
        )
        return true
      },
      clipboardTextSerializer: (slice) =>
        slice.content.textBetween(0, slice.content.size, "\n", (node) =>
          node.type.name === "skill"
            ? `[$${node.attrs.name}](${node.attrs.path})`
            : "",
        ),
      clipboardTextParser: (text) => new Slice(parsePrompt(text).content, 1, 1),
      handleDOMEvents: {
        focus: () => {
          latest.current.onFocus?.()
          return false
        },
        blur: () => {
          latest.current.onBlur?.()
          return false
        },
      },
    })
    editor.current = view
    return () => {
      view.destroy()
      editor.current = null
    }
  }, [])

  useLayoutEffect(() => {
    const view = editor.current
    if (!view) return
    if (serializePrompt(view.state.doc) !== props.value && !view.composing) {
      // External draft restoration/clear starts a fresh undo history, so Undo
      // cannot bring a sent message or another session's draft back.
      view.updateState(
        EditorState.create({
          doc: parsePrompt(props.value),
          plugins: view.state.plugins,
        }),
      )
      view.dispatch(
        view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)),
      )
    }
    view.setProps({
      editable: () => !props.disabled,
      attributes: {
        role: "textbox",
        "aria-label": props.label,
        "aria-multiline": "true",
        "aria-autocomplete": "list",
        "aria-disabled": String(!!props.disabled),
        "data-placeholder": props.placeholder ?? "",
        ...(props.menuOpen ? { "aria-controls": "composer-suggestions" } : {}),
        ...(props.activeSuggestion
          ? { "aria-activedescendant": props.activeSuggestion }
          : {}),
      },
    })
  }, [
    props.value,
    props.disabled,
    props.menuOpen,
    props.activeSuggestion,
    props.label,
    props.placeholder,
  ])

  return <div ref={host} className={`prompt-editor ${props.className ?? ""}`} />
}
