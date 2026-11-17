// @vitest-environment happy-dom
import { cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { SourceCode } from "../../src/gui/components/source-code.tsx"

afterEach(cleanup)

it("highlights source by path without changing line content or numbering", async () => {
  const code =
    'const answer: string = "你好"\r\n\t// blank line follows\r\n\r\n'
  const { container } = render(
    <SourceCode code={code} path="src/example.ts" offset={41} />,
  )
  const source = () =>
    [...container.querySelectorAll(".source-code-content")]
      .map((cell) => cell.textContent)
      .join("\n")
  expect(source()).toBe(code)
  await waitFor(() =>
    expect(container.querySelector(".source-code-token")).not.toBeNull(),
  )
  expect(source()).toBe(code)
  expect(
    [...container.querySelectorAll(".source-code-number")].map(
      (cell) => cell.textContent,
    ),
  ).toEqual(["41", "42", "43", "44"])
  const token = container.querySelector<HTMLElement>(".source-code-token")
  expect(token?.style.getPropertyValue("--shiki-light")).toMatch(/^#/)
  expect(token?.style.getPropertyValue("--shiki-dark")).toMatch(/^#/)
})

it("renders HTML and script syntax as literal source before and after highlighting", async () => {
  const code =
    '<script>window.injected = true</script>\n<img src=x onerror="alert(1)">\n<&>'
  const { container } = render(<SourceCode code={code} path="example.html" />)
  expect(container.querySelector("script, img")).toBeNull()
  await waitFor(() =>
    expect(container.querySelector(".source-code-token")).not.toBeNull(),
  )
  expect(container.querySelector("script, img")).toBeNull()
  expect(
    [...container.querySelectorAll(".source-code-content")].map(
      (cell) => cell.textContent,
    ),
  ).toEqual([
    "<script>window.injected = true</script>",
    '<img src=x onerror="alert(1)">',
    "<&>",
  ])
})

it("keeps unknown languages and long source lines plain without losing text", async () => {
  const { container, rerender } = render(
    <SourceCode code="const value = 1" path="example.ts" />,
  )
  await waitFor(() =>
    expect(container.querySelector(".source-code-token")).not.toBeNull(),
  )
  const code = "<script> literal & text\t\n\nlast"
  rerender(<SourceCode code={code} path="example.constructor" wrap />)
  expect(container.querySelector(".source-code-token")).toBeNull()
  expect(container.querySelector("script")).toBeNull()
  expect(
    container.querySelector(".source-code")?.getAttribute("data-wrap"),
  ).toBe("true")
  expect(
    [...container.querySelectorAll(".source-code-content")].map(
      (cell) => cell.textContent,
    ),
  ).toEqual(["<script> literal & text\t", "", "last"])

  const minified = `const value = "${"x".repeat(4096)}"`
  rerender(<SourceCode code={minified} path="large.ts" />)
  expect(container.querySelector(".source-code-token")).toBeNull()
  expect(container.querySelector(".source-code-content")?.textContent).toBe(
    minified,
  )
})
