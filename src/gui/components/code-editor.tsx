import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { Annotation, Compartment, EditorState } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"
import { tags } from "@lezer/highlight"
import { basicSetup } from "codemirror"
import { useEffect, useLayoutEffect, useRef } from "react"
import "./code-editor.css"

const colors = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier], color: "var(--editor-keyword)" },
  { tag: [tags.string, tags.regexp], color: "var(--editor-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--editor-number)" },
  {
    tag: [tags.function(tags.variableName), tags.typeName],
    color: "var(--editor-function)",
  },
  { tag: tags.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
])
const externalValue = Annotation.define<boolean>()

export function CodeEditor({
  value,
  path,
  wrap,
  onChange,
  onSave,
}: Readonly<{
  value: string
  path: string
  wrap: boolean
  onChange(value: string): void
  onSave(): void
}>) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorView>(undefined)
  const callbacks = useRef({ onChange, onSave })
  callbacks.current = { onChange, onSave }
  const latestValue = useRef(value)
  latestValue.current = value
  const wrapping = useRef(new Compartment())
  const initialWrap = useRef(wrap)
  useLayoutEffect(() => {
    if (!host.current) return
    const language = new Compartment()
    // Explicit separators preserve CRLF and BOM on save. Mixed endings retain
    // their CR characters instead of silently normalizing the original file.
    const source = latestValue.current
    const separator =
      source.includes("\r\n") && !/(?<!\r)\n|\r(?!\n)/.test(source)
        ? "\r\n"
        : source.includes("\r") && !source.includes("\n")
          ? "\r"
          : "\n"
    const normalizeInput = (text: string) =>
      text.replace(/\r\n?|\n/g, separator)
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: source,
        extensions: [
          basicSetup,
          EditorState.lineSeparator.of(separator),
          // Clipboard and DOM input use platform line endings, which may differ
          // from the file. Convert before CodeMirror constructs its line tree.
          EditorView.clipboardInputFilter.of(normalizeInput),
          EditorView.inputHandler.of((view, from, to, text) => {
            const normalized = normalizeInput(text)
            if (normalized === text) return false
            view.dispatch({
              changes: { from, to, insert: normalized },
              selection: {
                anchor: from + view.state.toText(normalized).length,
              },
              userEvent: "input.type",
              scrollIntoView: true,
            })
            return true
          }),
          EditorView.contentAttributes.of({ "aria-label": `Edit ${path}` }),
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                callbacks.current.onSave()
                return true
              },
            },
          ]),
          syntaxHighlighting(colors),
          language.of([]),
          wrapping.current.of(
            initialWrap.current ? EditorView.lineWrapping : [],
          ),
          EditorView.updateListener.of((update) => {
            if (
              update.transactions.some(
                (transaction) =>
                  transaction.docChanged &&
                  !transaction.annotation(externalValue),
              )
            )
              callbacks.current.onChange(update.state.sliceDoc())
          }),
        ],
      }),
    })
    editor.current = view
    let active = true
    void import("@codemirror/language-data")
      .then(async ({ languages }) => {
        const { LanguageDescription } = await import("@codemirror/language")
        const description = LanguageDescription.matchFilename(languages, path)
        if (description) {
          const support = await description.load()
          if (active) view.dispatch({ effects: language.reconfigure(support) })
        }
      })
      .catch(() => {
        // Optional grammar chunks may be unavailable offline; editing stays plain.
      })
    view.focus()
    return () => {
      active = false
      editor.current = undefined
      view.destroy()
    }
  }, [path])
  useLayoutEffect(() => {
    const view = editor.current
    if (!view || view.state.sliceDoc() === value) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      // Prop echoes must finish during commit, before another editor input can
      // arrive. Applying them is not a new user edit to persist again.
      annotations: externalValue.of(true),
    })
  }, [value])
  useEffect(() => {
    editor.current?.dispatch({
      effects: wrapping.current.reconfigure(
        wrap ? EditorView.lineWrapping : [],
      ),
    })
  }, [wrap])
  return <div className="code-editor" ref={host} />
}
