// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { HtmlPreview } from "../../src/gui/components/html-preview.tsx"

afterEach(cleanup)

it("confines untrusted HTML to a sandboxed document with resource loading blocked", () => {
  const html =
    '<img src="/app-secret"><script>alert(1)</script><style>body { color: red }</style>'
  const { getByTitle } = render(
    <HtmlPreview content={html} truncated={false} />,
  )
  const frame = getByTitle("HTML file preview") as HTMLIFrameElement
  const doc = frame.getAttribute("srcdoc") ?? ""

  expect(frame.getAttribute("sandbox")).toBe("")
  expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer")
  expect(doc.indexOf('http-equiv="Content-Security-Policy"')).toBeLessThan(
    doc.indexOf(html),
  )
  expect(doc).toContain("default-src 'none'")
  expect(doc).toContain("script-src 'none'")
  expect(doc).toContain("style-src 'unsafe-inline'")
  expect(doc).toContain("img-src data:")
  expect(doc).toContain("frame-src 'none'")
  expect(doc).toContain("base-uri 'none'")
  expect(doc).toContain("form-action 'none'")
  expect(doc).toContain(html)
  expect(document.querySelector("script, img, style")).toBeNull()
})

it("marks a truncated document as an incomplete preview", () => {
  const { getByRole } = render(<HtmlPreview content="<main>" truncated />)
  expect(getByRole("status").textContent).toMatch(/incomplete/i)
})

it("removes automatic meta refresh without losing the document content", () => {
  const { getByTitle } = render(
    <HtmlPreview
      content={
        '<!doctype html><html><head><meta HTTP-EQUIV=" Refresh " content="0;url=https://example.com"><style>h1 { color: red }</style></head><body><h1>Keep this</h1><a href="next.html">Next</a></body></html>'
      }
      truncated={false}
    />,
  )
  const srcDoc = getByTitle("HTML file preview").getAttribute("srcdoc") ?? ""
  expect(srcDoc).not.toMatch(/http-equiv=["']\s*refresh/i)
  expect(srcDoc).toContain("<h1>Keep this</h1>")
  expect(srcDoc).toContain("h1 { color: red }")
  expect(srcDoc).toContain('href="next.html"')
})
