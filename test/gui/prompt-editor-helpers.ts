import { act, fireEvent } from "@testing-library/react"

// Exercise the editor's real clipboard and DOM selection boundaries. happy-dom
// cannot emulate browser contenteditable text insertion through beforeinput.
export async function pastePrompt(
  editor: HTMLElement,
  text: string,
  replace = false,
) {
  await act(async () => {
    editor.focus()
    if (replace) fireEvent.keyDown(editor, { key: "a", ctrlKey: true })
    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === "text/plain" ? text : ""),
      },
    })
  })
}

export async function selectPrompt(editor: HTMLElement, offset: number) {
  await act(async () => {
    editor.focus()
    const text = editor.querySelector("p")?.firstChild
    if (!text) throw new Error("Expected a text paragraph")
    const selection = window.getSelection()
    selection?.collapse(text, offset)
    document.dispatchEvent(new Event("selectionchange"))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
}
