import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { MarkdownView } from "../../src/gui/components/markdown.tsx"

afterEach(cleanup)

// Use the real lazy-loaded parser here. DOM lifecycle tests use a controllable
// renderer; actual SVG layout and image decoding belong to the browser lane.
it("shows the real Mermaid parser's failure alongside the unchanged source", async () => {
  const source = "flowchart LR\nA[unfinished"
  const { container } = render(
    <MarkdownView text={`\`\`\`mermaid\n${source}\n\`\`\``} />,
  )
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain(
      "Could not render Mermaid diagram.",
    ),
  )
  expect(screen.getByRole("status").textContent).toMatch(/Parse error/i)
  expect(container.querySelector("pre")?.textContent).toBe(`${source}\n`)
  expect(screen.queryByRole("img", { name: "Mermaid diagram" })).toBeNull()
  expect(document.body.querySelector("[inert]")).toBeNull()
})
