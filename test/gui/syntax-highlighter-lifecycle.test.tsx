// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import {
  loadLanguage,
  useSyntaxTokens,
} from "../../src/gui/lib/syntax-highlighter.ts"

const { pending, highlighter } = vi.hoisted(() => {
  const pending = new Map<
    string,
    { resolve(): void; reject(error: Error): void }
  >()
  return {
    pending,
    highlighter: {
      loadLanguage: vi.fn(
        (grammars: readonly { name: string }[]) =>
          new Promise<void>((resolve, reject) => {
            const name = grammars[0]?.name
            if (!name) throw new Error("Grammar must identify its owner")
            pending.set(name, { resolve, reject })
          }),
      ),
      codeToTokensWithThemes: vi.fn(
        (code: string, options: { lang: string }) => [
          [
            {
              content: code,
              offset: 0,
              variants: {
                light: { color: options.lang },
                dark: { color: options.lang },
              },
            },
          ],
        ],
      ),
    },
  }
})
vi.mock("shiki/core", () => ({
  createHighlighterCore: async () => highlighter,
}))
vi.mock("shiki/engine/javascript", () => ({
  createJavaScriptRegexEngine: () => ({}),
}))

function Tokens({
  code,
  language,
}: {
  code: string
  language: "typescript" | "javascript" | "python" | undefined
}) {
  const tokens = useSyntaxTokens(code, language)
  return (
    <output>
      {tokens
        ? `${tokens[0]?.[0]?.variants.light?.color}:${tokens[0]?.[0]?.content}`
        : `plain:${code}`}
    </output>
  )
}

afterEach(cleanup)

it("keeps lazy language results owned by the current code view and retries a failed grammar on remount", async () => {
  const { rerender, unmount } = render(
    <Tokens code="old" language="typescript" />,
  )
  await waitFor(() => expect(pending.has("typescript")).toBe(true))
  // Concurrent consumers share one grammar load, while the view can change owners.
  const shared = loadLanguage("typescript")
  expect(loadLanguage("typescript")).toBe(shared)
  rerender(<Tokens code="current" language="javascript" />)
  await waitFor(() => expect(pending.has("javascript")).toBe(true))
  await act(async () => pending.get("javascript")?.resolve())
  expect(screen.getByRole("status").textContent).toBe("javascript:current")
  await act(async () => {
    pending.get("typescript")?.resolve()
    await shared
  })
  expect(screen.getByRole("status").textContent).toBe("javascript:current")
  rerender(<Tokens code="unknown" language={undefined} />)
  expect(screen.getByRole("status").textContent).toBe("plain:unknown")
  rerender(<Tokens code="retry" language="python" />)
  await waitFor(() => expect(pending.has("python")).toBe(true))
  await act(async () =>
    pending.get("python")?.reject(new Error("Lazy chunk failed")),
  )
  expect(screen.getByRole("status").textContent).toBe("plain:retry")
  unmount()
  const previous = pending.get("python")
  render(<Tokens code="retry" language="python" />)
  await waitFor(() => expect(pending.get("python")).not.toBe(previous))
  await act(async () => pending.get("python")?.resolve())
  expect(screen.getByRole("status").textContent).toBe("python:retry")
  expect(highlighter.loadLanguage).toHaveBeenCalledTimes(4)
})
