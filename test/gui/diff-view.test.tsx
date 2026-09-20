// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { DiffView } from "../../src/gui/components/cells/diff-view.tsx"

afterEach(cleanup)

const patch =
  "--- a/old name.txt\n+++ b/new name.txt\n@@ -4,2 +4,3 @@\n unchanged\n-old\n+new\n+more"

it("shows renamed file identity, change counts and separate old/new gutters", () => {
  render(<DiffView diff={{ text: patch, truncated: false }} />)
  expect(screen.getByText("old name.txt → new name.txt")).toBeDefined()
  expect(screen.getByLabelText("2 additions, 1 deletions")).toBeDefined()
  const rows = within(screen.getByRole("table")).getAllByRole("row")
  expect(
    rows.slice(2).map((row) =>
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ),
  ).toEqual([
    ["4", "4", " unchanged"],
    ["5", "", "-old"],
    ["", "5", "+new"],
    ["", "6", "+more"],
  ])
})

it("exposes the verbatim original patch and toggles wrapping without changing its content", () => {
  render(<DiffView diff={{ text: patch, truncated: false }} />)
  fireEvent.click(screen.getByRole("button", { name: "Raw" }))
  expect(
    screen.getByRole("region", { name: "File diff" }).querySelector("pre")
      ?.textContent,
  ).toBe(patch)
  fireEvent.click(screen.getByRole("button", { name: "Wrap diff lines" }))
  expect(
    screen
      .getByRole("button", { name: "Wrap diff lines" })
      .getAttribute("aria-pressed"),
  ).toBe("true")
  expect(
    screen.getByRole("region", { name: "File diff" }).getAttribute("data-wrap"),
  ).toBe("true")
  fireEvent.click(screen.getByRole("button", { name: "Raw" }))
  expect(screen.getByRole("table")).toBeDefined()
})

it("shows truncated or unstructured content without fabricated line numbers or counts", () => {
  const text =
    "--- a/file.txt\n+++ b/file.txt\n@@ -1,2 +1,2 @@\n-old\n+new\n...[diff truncated]"
  const { rerender, container } = render(
    <DiffView diff={{ text, truncated: true }} />,
  )
  expect(screen.getByText("Partial diff")).toBeDefined()
  expect(
    screen.getByText("Incomplete patch · original text shown"),
  ).toBeDefined()
  expect(container.querySelector("pre")?.textContent).toBe(text)
  expect(screen.queryByRole("table")).toBeNull()
  rerender(<DiffView diff={{ text: "+staged content", truncated: false }} />)
  expect(screen.getByText("+staged content")).toBeDefined()
})

it("uses the supplied path for hunk-only patches and keeps source intact after highlighting", async () => {
  const { container } = render(
    <DiffView
      path="src/app.ts"
      diff={{
        text: "@@ -1,3 +1,3 @@\n /* comment\n-old text\n+new text\n */",
        truncated: false,
      }}
    />,
  )
  expect(screen.getByText("src/app.ts")).toBeDefined()
  await waitFor(() =>
    expect(container.querySelector(".review-diff-token")).not.toBeNull(),
  )
  expect(
    [...container.querySelectorAll(".review-diff-code")].map(
      (cell) => cell.textContent,
    ),
  ).toEqual([" /* comment", "-old text", "+new text", " */"])
})

it("preserves carriage returns in source lines when syntax highlighting normalizes them", async () => {
  const { container } = render(
    <DiffView
      path="src/app.ts"
      diff={{
        text: "@@ -1,2 +1,2 @@\n-const old = 1\r\n+const next = 2\r\n const end = 3\r",
        truncated: false,
      }}
    />,
  )
  await waitFor(() =>
    expect(container.querySelector(".review-diff-token")).not.toBeNull(),
  )
  expect(
    [...container.querySelectorAll(".review-diff-code")].map(
      (cell) => cell.textContent,
    ),
  ).toEqual(["-const old = 1\r", "+const next = 2\r", " const end = 3\r"])
})
