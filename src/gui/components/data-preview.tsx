import { useMemo } from "react"
import "./data-preview.css"

type DataPreviewProps = Readonly<{
  kind: "csv" | "json"
  content: string
  truncated: boolean
}>

type CsvResult = {
  rows: string[][]
  remainder: string
  issue?: string
}

// Bound DOM cells for wide files while retaining the original text in the source view.
const MAX_VISIBLE_ROWS = 500
const MAX_VISIBLE_COLUMNS = 80

function parseCsv(content: string, truncated: boolean): CsvResult {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let state: "start" | "plain" | "quoted" | "closed" = "start"
  let rowStart = 0
  let rowStarted = false
  let index = content.charCodeAt(0) === 0xfeff ? 1 : 0

  const finishRow = (next: number) => {
    row.push(field)
    rows.push(row)
    row = []
    field = ""
    state = "start"
    rowStarted = false
    rowStart = next
  }

  for (; index < content.length; index++) {
    // Workspace reads replace shortened source lines with this marker. Treat
    // the whole record as uncertain, including fields preceding the marker.
    if (content.startsWith("…[line truncated]…", index)) {
      return {
        rows,
        remainder: content.slice(rowStart),
        issue: "A source line was shortened.",
      }
    }
    const character = content[index]
    if (state === "quoted") {
      if (character === '"') {
        if (content[index + 1] === '"') {
          field += '"'
          index++
        } else {
          state = "closed"
        }
      } else {
        field += character
      }
      continue
    }

    if (character === "\r" || character === "\n") {
      finishRow(
        character === "\r" && content[index + 1] === "\n"
          ? index + 2
          : index + 1,
      )
      if (character === "\r" && content[index + 1] === "\n") index++
    } else if (character === ",") {
      row.push(field)
      field = ""
      state = "start"
      rowStarted = true
    } else if (state === "start" && character === '"') {
      state = "quoted"
      rowStarted = true
    } else if (character === '"') {
      return {
        rows,
        remainder: content.slice(rowStart),
        issue:
          state === "closed"
            ? "Unexpected quote after a quoted field."
            : "Unexpected quote in an unquoted field.",
      }
    } else if (state === "closed") {
      return {
        rows,
        remainder: content.slice(rowStart),
        issue: "Unexpected text after a quoted field.",
      }
    } else {
      field += character
      state = "plain"
      rowStarted = true
    }
  }

  if (rowStarted || row.length > 0) {
    if (truncated) {
      return { rows, remainder: content.slice(rowStart) }
    }
    if (state === "quoted") {
      return {
        rows,
        remainder: content.slice(rowStart),
        issue: "Unclosed quoted field.",
      }
    }
    finishRow(content.length)
  }

  return { rows, remainder: "" }
}

export function DataPreview({ kind, content, truncated }: DataPreviewProps) {
  const csv = useMemo(
    () => (kind === "csv" ? parseCsv(content, truncated) : undefined),
    [kind, content, truncated],
  )
  const json = useMemo(() => {
    if (kind !== "json" || truncated || !content.trim()) return undefined
    try {
      return JSON.stringify(JSON.parse(content), null, 2)
    } catch (cause) {
      if (cause instanceof SyntaxError) return undefined
      throw cause
    }
  }, [kind, content, truncated])

  if (kind === "json") {
    return (
      <div className="data-preview">
        {truncated || json === undefined ? (
          <>
            <p className="data-preview-notice" role="status">
              {truncated
                ? "Partial JSON content. The complete structure cannot be shown."
                : "Invalid JSON. Showing the original content."}
            </p>
            <pre className="data-preview-json">{content}</pre>
          </>
        ) : (
          <pre className="data-preview-json">{json}</pre>
        )}
      </div>
    )
  }

  const rows = csv?.rows ?? []
  const headers = rows[0] ?? []
  const records = rows.slice(1)
  const columns = Math.min(
    MAX_VISIBLE_COLUMNS,
    rows.reduce((width, row) => Math.max(width, row.length), 0),
  )
  const visibleRecords = records.slice(0, MAX_VISIBLE_ROWS)
  const unequalRows = records.some((row) => row.length !== headers.length)
  const limited =
    records.length > MAX_VISIBLE_ROWS ||
    rows.some((row) => row.length > MAX_VISIBLE_COLUMNS)

  return (
    <div className="data-preview">
      {truncated ? (
        <p className="data-preview-notice" role="status">
          Partial CSV content. Only complete records are shown below.
        </p>
      ) : null}
      {csv?.issue ? (
        <p className="data-preview-notice" role="status">
          Record {rows.length + 1} could not be parsed: {csv.issue} Earlier
          records are shown below.
        </p>
      ) : null}
      {unequalRows ? (
        <p className="data-preview-notice" role="status">
          Some records have a different number of fields than the header.
          Missing fields are marked with a dash; extra fields have numbered
          columns.
        </p>
      ) : null}
      {limited ? (
        <p className="data-preview-notice" role="status">
          Showing the first {Math.min(records.length, MAX_VISIBLE_ROWS)} of{" "}
          {records.length} loaded records and at most {MAX_VISIBLE_COLUMNS}{" "}
          columns.
        </p>
      ) : null}
      {headers.length > 0 ? (
        <div className="data-preview-table-scroll">
          <table className="data-preview-table">
            <thead>
              <tr>
                <th scope="col" className="data-preview-index">
                  #
                </th>
                {Array.from({ length: columns }, (_, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: CSV columns are identified by their position.
                  <th scope="col" key={index}>
                    {headers[index] ||
                      (index < headers.length
                        ? `Column ${index + 1}`
                        : `Extra ${index + 1}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRecords.map((row, rowIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: CSV records are identified by their position.
                <tr key={rowIndex}>
                  <th scope="row" className="data-preview-index">
                    {rowIndex + 1}
                  </th>
                  {Array.from({ length: columns }, (_, columnIndex) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: CSV fields are identified by their position.
                    <td key={columnIndex}>
                      {columnIndex < row.length ? (
                        row[columnIndex]
                      ) : (
                        <span
                          className="data-preview-missing"
                          title="Missing field"
                        >
                          —
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {csv?.remainder ? (
        <div className="data-preview-remainder">
          <p>{csv.issue ? "Unparsed record" : "Incomplete final record"}</p>
          <pre>{csv.remainder}</pre>
        </div>
      ) : null}
    </div>
  )
}
