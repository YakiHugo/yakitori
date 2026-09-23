// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { DataPreview } from "../../src/gui/components/data-preview.tsx"

afterEach(cleanup)

it("parses quoted CSV fields, multiline values, escaped quotes, and empty values", () => {
  render(
    <DataPreview
      kind="csv"
      content={
        'name,note,blank\r\nAda,"first,\r\nsecond ""line""",\r\nLin,plain,ok'
      }
      truncated={false}
    />,
  )
  const table = screen.getByRole("table")
  expect(
    within(table)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent),
  ).toEqual(["#", "name", "note", "blank"])
  const records = within(table).getAllByRole("row").slice(1)
  const firstRecord = records[0]
  const secondRecord = records[1]
  if (!firstRecord || !secondRecord)
    throw new Error("Expected two CSV records.")
  expect(
    within(firstRecord)
      .getAllByRole("cell")
      .map((cell) => cell.textContent),
  ).toEqual(["Ada", 'first,\r\nsecond "line"', ""])
  expect(
    within(secondRecord)
      .getAllByRole("cell")
      .map((cell) => cell.textContent),
  ).toEqual(["Lin", "plain", "ok"])
})

it("surfaces malformed records and keeps only preceding valid rows in the table", () => {
  render(
    <DataPreview
      kind="csv"
      content={'name,amount\nAlice,10\nBob,"closed"suffix\nCarla,30'}
      truncated={false}
    />,
  )
  expect(screen.getByRole("table").textContent).toContain("Alice")
  expect(screen.getByRole("table").textContent).not.toContain("Bob")
  expect(screen.getByText(/Record 3 could not be parsed/)).toBeTruthy()
  expect(screen.getByText(/Bob,"closed"suffix/).textContent).toContain(
    "Carla,30",
  )
})

it("does not present a trailing partial CSV row as a complete record", () => {
  render(
    <DataPreview
      kind="csv"
      content={"name,amount\nAlice,10\nBob,3"}
      truncated
    />,
  )
  expect(screen.getByRole("table").textContent).toContain("Alice")
  expect(screen.getByRole("table").textContent).not.toContain("Bob")
  expect(screen.getByText("Incomplete final record")).toBeTruthy()
  expect(screen.getByText("Bob,3")).toBeTruthy()
  expect(screen.getByText(/Partial CSV content/)).toBeTruthy()
})

it("leaves shortened and unterminated CSV records visible as raw text", () => {
  const { rerender } = render(
    <DataPreview
      kind="csv"
      content={"name,note\nAda,ok\nBob,head…[line truncated]…tail\nEve,ok"}
      truncated
    />,
  )
  expect(screen.getByRole("table").textContent).toContain("Ada")
  expect(screen.getByRole("table").textContent).not.toContain("Bob")
  expect(screen.getByText(/source line was shortened/)).toBeTruthy()
  expect(screen.getByText(/Bob,head…\[line truncated\]…tail/)).toBeTruthy()

  rerender(
    <DataPreview
      kind="csv"
      content={'name,note\nAda,ok\nBob,"unfinished'}
      truncated={false}
    />,
  )
  expect(screen.getByText(/Unclosed quoted field/)).toBeTruthy()
  expect(screen.getByText('Bob,"unfinished')).toBeTruthy()
})

it("marks inconsistent CSV rows without treating missing fields as empty values", () => {
  render(
    <DataPreview
      kind="csv"
      content={"first,second\none\ntwo,three,four"}
      truncated={false}
    />,
  )
  expect(screen.getByText(/different number of fields/)).toBeTruthy()
  expect(screen.getAllByTitle("Missing field")).toHaveLength(2)
  expect(screen.getByRole("columnheader", { name: "Extra 3" })).toBeTruthy()
})

it("shows valid JSON formatted and uses the original text for invalid or partial JSON", () => {
  const { rerender } = render(
    <DataPreview
      kind="json"
      content={'{"name":"Ada","data":[true,null]}'}
      truncated={false}
    />,
  )
  expect(screen.getByText(/"name": "Ada"/).textContent).toBe(
    '{\n  "name": "Ada",\n  "data": [\n    true,\n    null\n  ]\n}',
  )
  rerender(<DataPreview kind="json" content='{"name":' truncated={false} />)
  expect(screen.getByText(/Invalid JSON/)).toBeTruthy()
  expect(screen.getByText('{"name":')).toBeTruthy()
  rerender(<DataPreview kind="json" content='{"name":"Ada"}' truncated />)
  expect(screen.getByText(/Partial JSON content/)).toBeTruthy()
  expect(screen.getByText('{"name":"Ada"}')).toBeTruthy()
})
