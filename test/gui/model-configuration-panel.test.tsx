// @vitest-environment happy-dom
import { EditorView } from "@codemirror/view"
import { act, cleanup, render, screen } from "@testing-library/react"
import { useLayoutEffect } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { ModelConfigurationPanel } from "../../src/gui/components/model-configuration-panel.tsx"
import type { ModelSettings } from "../../src/protocol/providers.ts"

vi.mock("../../src/gui/lib/rpc-client.ts", () => ({
  getAppRpcClient: () => ({
    request: async () => ({
      layers: [{ source: "user", path: "/home/config.toml" }],
    }),
  }),
}))
afterEach(cleanup)

it("keeps newer typing when a model settings echo commits before passive effects", async () => {
  const onChange = vi.fn()
  const model = { id: "coder", contextWindowTokens: 100000 }
  let editor: EditorView
  function Owner({
    settings,
    type,
  }: {
    settings: ModelSettings
    type: boolean
  }) {
    useLayoutEffect(() => {
      if (!type) return
      const from =
        editor.state.sliceDoc().indexOf("contextWindowTokens = 6") +
        "contextWindowTokens = 6".length
      editor.dispatch({
        changes: { from, insert: "4000" },
        selection: { anchor: from + 4 },
        userEvent: "input.type",
      })
    }, [type])
    return (
      <ModelConfigurationPanel
        apiBase="/api"
        provider="custom"
        model={model}
        settings={settings}
        onChange={onChange}
        onClose={() => {}}
      />
    )
  }
  const view = render(<Owner settings={{}} type={false} />)
  const content = await screen.findByRole("textbox", {
    name: "Edit /home/config.toml",
  })
  const attached = EditorView.findFromDOM(content)
  if (!attached) throw new Error("Missing real editor")
  editor = attached
  const partial =
    "[models.custom.coder]\n# Keep my notes\ncontextWindowTokens = 6\n"
  act(() => {
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: partial },
      userEvent: "input.type",
    })
  })
  expect(onChange).toHaveBeenLastCalledWith({ contextWindowTokens: 6 })
  view.rerender(<Owner settings={{ contextWindowTokens: 6 }} type />)
  expect(editor.state.sliceDoc()).toBe(partial.replace("= 6", "= 64000"))
  expect(editor.state.selection.main.head).toBe(
    partial.indexOf("= 6") + "= 64000".length,
  )
  expect(onChange).toHaveBeenLastCalledWith({ contextWindowTokens: 64000 })
})

it("applies external settings without reporting another edit", async () => {
  const onChange = vi.fn()
  const model = { id: "coder", contextWindowTokens: 100000 }
  const props = {
    apiBase: "/api",
    provider: "custom",
    model,
    onChange,
    onClose: () => {},
  }
  const view = render(
    <ModelConfigurationPanel
      {...props}
      settings={{ contextWindowTokens: 64000 }}
    />,
  )
  const content = await screen.findByRole("textbox", {
    name: "Edit /home/config.toml",
  })
  view.rerender(
    <ModelConfigurationPanel
      {...props}
      settings={{ contextWindowTokens: 128000 }}
    />,
  )
  expect(EditorView.findFromDOM(content)?.state.sliceDoc()).toContain(
    "contextWindowTokens = 128000",
  )
  expect(onChange).not.toHaveBeenCalled()
})
