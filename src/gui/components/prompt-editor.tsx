import { baseKeymap, selectAll, splitBlock } from "prosemirror-commands"
import { closeHistory, history, redo, undo } from "prosemirror-history"
import { keymap } from "prosemirror-keymap"
import { Slice } from "prosemirror-model"
import {
  EditorState,
  type SelectionBookmark,
  TextSelection,
} from "prosemirror-state"
import { EditorView } from "prosemirror-view"
import {
  type Ref,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react"
import type {
  ImageAttachment,
  ImageDetail,
  PdfAttachment,
  UserAttachment,
} from "../../protocol/asset-types.ts"
import { assetSourceKey } from "../../protocol/asset-types.ts"
import { isUnmodifiedEscape } from "../lib/escape-key.ts"
import type { InputDraft } from "../../protocol/user-input.ts"
import { inputAttachmentOwnership } from "../input-attachment-ownership.ts"
import { appendDraftImages, sameInputDraft } from "../input-draft.ts"
import { useAppStore } from "../store/app-store.ts"
import { useWorkspaceStore } from "../store/workspace-store.ts"
import {
  parsePrompt,
  parsePromptParts,
  promptOffset,
  promptPosition,
  serializePromptParts,
} from "./prompt-document.ts"

export type PromptEditorHandle = Readonly<{
  focus(atEnd?: boolean): void
  captureAttachmentInsertion(): Readonly<{
    insert(attachments: readonly UserAttachment[]): boolean
    cancel(): void
  }>
  removeAttachment(index: number): void
  setImageDetail(index: number, detail: ImageDetail): void
  replaceRange(
    from: number,
    to: number,
    text: string,
    cursorOffset?: number,
  ): void
}>

// Classification follows the draft layer's mediaType split; the strict
// isImageAttachment validator would silently drop attachments carrying
// extra metadata keys.
const isDraftImage = (
  attachment: UserAttachment,
): attachment is ImageAttachment => attachment.mediaType !== "application/pdf"

// A collapsed import bookmark stays before text typed while bytes are loading.
// Positions are mapped through every ProseMirror transaction, not text offsets.
function attachmentInsertionBookmark(position: number): SelectionBookmark {
  return {
    map: (mapping) => attachmentInsertionBookmark(mapping.map(position, -1)),
    resolve: (doc) => TextSelection.near(doc.resolve(position)),
  }
}

type Props = Readonly<{
  ref?: Ref<PromptEditorHandle>
  value: InputDraft
  // History recall temporarily parks the unsent draft outside this document.
  parkedParts?: InputDraft | undefined
  apiBase: string
  label: string
  placeholder?: string
  disabled?: boolean
  className?: string
  activeSuggestion?: string | undefined
  menuOpen?: boolean
  suggestionsId?: string
  onChange(parts: InputDraft): void
  onOpenDocument?(document: PdfAttachment): void
  onDiscardAttachments?(images: readonly UserAttachment[]): void
  onSelection?(from: number, to: number): void
  onKeyDown?(event: globalThis.KeyboardEvent): boolean
  onPasteAttachments?(files: File[]): void
  onFocus?(): void
  onBlur?(): void
}>

// Codex uses ProseMirror for its composer. Keep selection, IME, clipboard and
// undo in the editor transaction boundary; React owns suggestions and submission.
export function PromptEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorView | null>(null)
  const latest = useRef(props)
  const insertions = useRef(new Set<{ bookmark: SelectionBookmark }>())
  // Images are attachments, not document content: they bypass the document and
  // rejoin every emitted draft, so text edits can never move or delete them.
  const preservedImages = useRef<readonly ImageAttachment[]>([])
  const retainedAttachments = useRef(new Map<string, UserAttachment>())
  const rememberAttachments = useCallback((parts: InputDraft) => {
    for (const part of parts.attachments)
      if (
        !("url" in part.file) &&
        part.file.path.startsWith("attachments/staging/")
      )
        retainedAttachments.current.set(assetSourceKey(part.file), {
          name: part.name,
          mediaType: part.mediaType,
          sizeBytes: part.sizeBytes,
          ...("detail" in part && part.detail !== undefined
            ? { detail: part.detail }
            : {}),
          file: part.file,
        })
  }, [])
  const releaseUnusedAttachments = useCallback(
    (parts: InputDraft) => {
      const owned = [
        ...parts.attachments,
        ...(latest.current.parkedParts?.attachments ?? []),
      ]
      const live = new Set(owned.flatMap((part) => [assetSourceKey(part.file)]))
      const unused = [...retainedAttachments.current].filter(
        ([key]) => !live.has(key),
      )
      for (const [key] of unused) retainedAttachments.current.delete(key)
      if (unused.length)
        latest.current.onDiscardAttachments?.(unused.map(([, image]) => image))
      // The surface owns parked snapshots across keyed editor remounts.
      for (const part of latest.current.parkedParts?.attachments ?? [])
        retainedAttachments.current.delete(assetSourceKey(part.file))
      rememberAttachments(parts)
    },
    [rememberAttachments],
  )
  useLayoutEffect(() => {
    latest.current = props
  })

  const currentDraft = useCallback(
    (view: EditorView): InputDraft =>
      appendDraftImages(
        serializePromptParts(view.state.doc, (attachment) =>
          inputAttachmentOwnership.resolve(latest.current.apiBase, attachment),
        ),
        preservedImages.current,
      ),
    [],
  )
  const emitChange = useCallback(
    (view: EditorView) => {
      const parts = currentDraft(view)
      rememberAttachments(parts)
      latest.current.onChange(parts)
    },
    [currentDraft, rememberAttachments],
  )

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
      captureAttachmentInsertion() {
        const view = editor.current
        if (!view) return { insert: () => false, cancel: () => {} }
        const pending = {
          bookmark: view.state.selection.empty
            ? attachmentInsertionBookmark(view.state.selection.from)
            : view.state.selection.getBookmark(),
        }
        insertions.current.add(pending)
        return {
          insert(attachments) {
            if (editor.current !== view || !insertions.current.delete(pending))
              return false
            const images = attachments.filter(isDraftImage)
            if (images.length > 0)
              preservedImages.current = [...preservedImages.current, ...images]
            const selection = pending.bookmark.resolve(view.state.doc)
            // Image parts are skipped by the schema, so only PDF atoms land
            // in the document at the bookmark position.
            const content = parsePromptParts({
              kind: "input",
              text: "",
              elements: [],
              attachments,
            }).firstChild?.content
            if (content && content.size > 0)
              view.dispatch(
                closeHistory(view.state.tr).replaceWith(
                  selection.from,
                  selection.to,
                  content,
                ),
              )
            // An image-only import leaves the document unchanged, so no
            // transaction will report the new draft.
            else emitChange(view)
            return true
          },
          cancel() {
            insertions.current.delete(pending)
          },
        }
      },
      removeAttachment(index) {
        const view = editor.current
        if (!view) return
        let count = 0
        let removedDocument = false
        view.state.doc.descendants((node, pos) => {
          if (node.type.name !== "document") return
          if (count++ === index) {
            removedDocument = true
            view.dispatch(
              closeHistory(view.state.tr).delete(pos, pos + node.nodeSize),
            )
          }
        })
        if (removedDocument) return
        const imageIndex = index - count
        if (preservedImages.current[imageIndex] === undefined) return
        preservedImages.current = preservedImages.current.filter(
          (_, candidate) => candidate !== imageIndex,
        )
        emitChange(view)
        // Images have no Undo path back, so removed staging bytes release now.
        releaseUnusedAttachments(currentDraft(view))
      },
      setImageDetail(index, detail) {
        const view = editor.current
        if (!view) return
        let count = 0
        view.state.doc.descendants((node) => {
          if (node.type.name === "document") count++
        })
        const imageIndex = index - count
        if (preservedImages.current[imageIndex] === undefined) return
        preservedImages.current = preservedImages.current.map((image, i) =>
          i === imageIndex ? { ...image, detail } : image,
        )
        emitChange(view)
      },
      replaceRange(from, to, text, cursorOffset) {
        const view = editor.current
        if (!view) return
        const start = promptPosition(view.state.doc, from)
        const end = promptPosition(view.state.doc, to)
        const content = parsePrompt(text).firstChild?.content
        if (!content) return
        const tr = closeHistory(view.state.tr).replaceWith(start, end, content)
        tr.setSelection(
          TextSelection.near(
            tr.doc.resolve(start + (cursorOffset ?? content.size)),
          ),
        )
        view.dispatch(tr.scrollIntoView())
        view.focus()
      },
    }),
    [currentDraft, emitChange, releaseUnusedAttachments],
  )

  useLayoutEffect(() => {
    if (!host.current) return
    preservedImages.current =
      latest.current.value.attachments.filter(isDraftImage)
    rememberAttachments(latest.current.value)
    const doc = parsePromptParts(latest.current.value)
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
        for (const pending of insertions.current)
          pending.bookmark = pending.bookmark.map(tr.mapping)
        view.updateState(view.state.apply(tr))
        if (tr.docChanged) emitChange(view)
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
        const images = Array.from(event.clipboardData?.files ?? [])
        if (images.length && latest.current.onPasteAttachments) {
          latest.current.onPasteAttachments(images)
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
            : node.type.name === "file"
              ? `[@${node.attrs.name}](${node.attrs.path})`
              : `[PDF: ${node.attrs.document.name}]`,
        ),
      clipboardTextParser: (text) => new Slice(parsePrompt(text).content, 1, 1),
      handleDOMEvents: {
        drop: (view, event) => {
          const images = Array.from(event.dataTransfer?.files ?? [])
          if (!images.length || !latest.current.onPasteAttachments) return false
          event.preventDefault()
          event.stopPropagation()
          const at = view.posAtCoords({
            left: event.clientX,
            top: event.clientY,
          })
          if (at)
            view.dispatch(
              view.state.tr.setSelection(
                TextSelection.near(view.state.doc.resolve(at.pos)),
              ),
            )
          latest.current.onPasteAttachments(images)
          return true
        },
        click: (view, event) => {
          const document =
            event.target instanceof Element
              ? event.target.closest<HTMLElement>("[data-prompt-document]")
              : null
          if (document) {
            const node = view.state.doc.nodeAt(view.posAtDOM(document, 0))
            if (node?.type.name === "document")
              latest.current.onOpenDocument?.(
                inputAttachmentOwnership.resolve(
                  latest.current.apiBase,
                  node.attrs.document as PdfAttachment,
                ) as PdfAttachment,
              )
            return true
          }
          const chip =
            event.target instanceof Element
              ? event.target.closest<HTMLElement>("[data-skill-path]")
              : null
          if (!chip) return false
          useWorkspaceStore
            .getState()
            .openSkill(
              chip.dataset.skillPath ?? "",
              chip.dataset.skillName ?? "",
              useAppStore.getState().selection.sessionId
                ? undefined
                : useAppStore.getState().currentProject,
            )
          return true
        },
        keydown: (view, event) => {
          if (isUnmodifiedEscape(event) && !view.composing) {
            // ProseMirror otherwise prevents every native Esc (keyCode 27),
            // even when no editor action handled it. Give local dismissals
            // first refusal, then let an unhandled Esc reach the chat scope.
            if (latest.current.onKeyDown?.(event)) event.preventDefault()
            return true
          }
          const document =
            event.target instanceof Element
              ? event.target.closest<HTMLElement>("[data-prompt-document]")
              : null
          if (document && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault()
            const node = view.state.doc.nodeAt(view.posAtDOM(document, 0))
            if (node?.type.name === "document")
              latest.current.onOpenDocument?.(
                inputAttachmentOwnership.resolve(
                  latest.current.apiBase,
                  node.attrs.document as PdfAttachment,
                ) as PdfAttachment,
              )
            return true
          }
          const chip =
            event.target instanceof Element
              ? event.target.closest<HTMLElement>("[data-skill-path]")
              : null
          if (!chip || (event.key !== "Enter" && event.key !== " "))
            return false
          event.preventDefault()
          useWorkspaceStore
            .getState()
            .openSkill(
              chip.dataset.skillPath ?? "",
              chip.dataset.skillName ?? "",
              useAppStore.getState().selection.sessionId
                ? undefined
                : useAppStore.getState().currentProject,
            )
          return true
        },
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
      insertions.current.clear()
      releaseUnusedAttachments(currentDraft(view))
      view.destroy()
      editor.current = null
    }
  }, [currentDraft, emitChange, rememberAttachments, releaseUnusedAttachments])

  useLayoutEffect(() => {
    const view = editor.current
    if (!view) return
    preservedImages.current = props.value.attachments.filter(isDraftImage)
    if (!sameInputDraft(currentDraft(view), props.value) && !view.composing) {
      insertions.current.clear()
      releaseUnusedAttachments(props.value)
      // External draft restoration/clear starts a fresh undo history, so Undo
      // cannot bring a sent message or another session's draft back.
      view.updateState(
        EditorState.create({
          doc: parsePromptParts(props.value),
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
        ...(props.menuOpen && props.suggestionsId
          ? { "aria-controls": props.suggestionsId }
          : {}),
        ...(props.activeSuggestion
          ? { "aria-activedescendant": props.activeSuggestion }
          : {}),
      },
    })
  }, [
    props.value,
    currentDraft,
    releaseUnusedAttachments,
    props.disabled,
    props.menuOpen,
    props.suggestionsId,
    props.activeSuggestion,
    props.label,
    props.placeholder,
  ])

  return <div ref={host} className={`prompt-editor ${props.className ?? ""}`} />
}
