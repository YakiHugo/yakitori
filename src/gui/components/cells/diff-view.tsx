import { FileCode2, WrapText } from "lucide-react"
import { memo, useMemo, useState } from "react"
import type { ToolDiff } from "../../execution-view.ts"
import {
  languageForPath,
  syntaxTokenStyle,
  useSyntaxTokens,
} from "../../lib/syntax-highlighter.ts"
import { type DiffFile, type DiffRow, parseDiff } from "./diff-model.ts"
import "./diff-view.css"

export const DiffView = memo(function DiffView({
  diff,
  path: fallbackPath,
}: Readonly<{ diff: ToolDiff; path?: string | undefined }>) {
  const model = useMemo(() => parseDiff(diff.text), [diff.text])
  const [wrap, setWrap] = useState(false)
  const [raw, setRaw] = useState(false)
  const showRaw = raw || model.kind === "raw"
  return (
    <section className="review-diff" data-wrap={wrap} aria-label="File diff">
      <div className="review-diff-toolbar">
        <span>{showRaw ? "Patch" : "Unified diff"}</span>
        {diff.truncated ? (
          <span className="review-diff-notice">Partial diff</span>
        ) : null}
        <div className="review-diff-controls">
          {model.kind === "unified" ? (
            <button
              type="button"
              aria-pressed={raw}
              onClick={() => setRaw(!raw)}
            >
              Raw
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Wrap diff lines"
            aria-pressed={wrap}
            onClick={() => setWrap(!wrap)}
          >
            <WrapText size={14} />
            Wrap
          </button>
        </div>
      </div>
      {model.kind === "raw" && diff.text !== "" ? (
        <p className="review-diff-explanation">
          {model.reason === "incomplete"
            ? "Incomplete patch · original text shown"
            : "Original patch"}
        </p>
      ) : null}
      {showRaw ? (
        <pre className="review-diff-raw">{diff.text || "No diff content."}</pre>
      ) : model.kind === "unified" ? (
        model.files.map((file) => {
          const added = file.oldPath === "/dev/null"
          const deleted = file.newPath === "/dev/null"
          const path =
            (deleted ? file.oldPath : file.newPath) || fallbackPath || "Changes"
          const renamed = !added && !deleted && file.oldPath !== file.newPath
          return (
            <div key={file.index} className="review-diff-file">
              <header className="review-diff-file-header">
                <FileCode2 size={14} />
                <span
                  className="review-diff-path"
                  title={renamed ? `${file.oldPath} → ${path}` : path}
                >
                  {renamed ? `${file.oldPath} → ${path}` : path}
                </span>
                {added || deleted ? (
                  <span className="review-diff-file-status">
                    {added ? "Added" : "Deleted"}
                  </span>
                ) : null}
                <span
                  className="review-diff-stats"
                  role="img"
                  aria-label={`${file.additions} additions, ${file.deletions} deletions${diff.truncated ? " shown" : ""}`}
                >
                  <span data-kind="addition">+{file.additions}</span>
                  <span data-kind="deletion">−{file.deletions}</span>
                </span>
              </header>
              <section
                className="review-diff-scroll"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded code viewport needs keyboard scrolling.
                tabIndex={0}
                aria-label={`Changes in ${path}`}
              >
                <table className="review-diff-table">
                  <colgroup>
                    <col className="review-diff-line-column" />
                    <col className="review-diff-line-column" />
                    <col />
                  </colgroup>
                  <thead className="sr-only">
                    <tr>
                      <th>Old line</th>
                      <th>New line</th>
                      <th>Change</th>
                    </tr>
                  </thead>
                  <DiffFileRows file={file} path={path} />
                </table>
              </section>
            </div>
          )
        })
      ) : null}
    </section>
  )
})

function DiffFileRows({
  file,
  path,
}: Readonly<{ file: DiffFile; path: string }>) {
  const hunks = useMemo(() => {
    const result: DiffRow[][] = []
    for (const row of file.rows) {
      if (row.kind === "hunk") result.push([row])
      else result.at(-1)?.push(row)
    }
    return result
  }, [file.rows])
  return hunks.map((rows) => (
    <DiffHunkRows key={rows[0]?.index} rows={rows} path={path} />
  ))
}

function DiffHunkRows({
  rows,
  path,
}: Readonly<{ rows: readonly DiffRow[]; path: string }>) {
  const language = languageForPath(path)
  // Tokenize each side of a hunk as a block, preserving multiline lexical
  // state without treating deleted and inserted text as one source document.
  const before = rows
    .filter((row) => row.oldLine !== undefined)
    .map((row) => row.text.slice(1))
    .join("\n")
  const after = rows
    .filter((row) => row.newLine !== undefined)
    .map((row) => row.text.slice(1))
    .join("\n")
  const beforeTokens = useSyntaxTokens(before, language)
  const afterTokens = useSyntaxTokens(after, language)
  let oldIndex = 0
  let newIndex = 0
  return (
    <tbody>
      {rows.map((row) => {
        const oldTokens =
          row.oldLine === undefined ? undefined : beforeTokens?.[oldIndex++]
        const newTokens =
          row.newLine === undefined ? undefined : afterTokens?.[newIndex++]
        const tokens = row.kind === "deletion" ? oldTokens : newTokens
        const faithfulTokens =
          tokens?.map((token) => token.content).join("") === row.text.slice(1)
        return (
          <tr key={row.index} data-kind={row.kind}>
            {row.kind === "hunk" || row.kind === "note" ? (
              <td colSpan={3} className="review-diff-context">
                {row.text}
              </td>
            ) : (
              <>
                <td className="review-diff-number">{row.oldLine}</td>
                <td className="review-diff-number">{row.newLine}</td>
                <td className="review-diff-code">
                  <code>
                    {tokens === undefined ||
                    tokens.length === 0 ||
                    !faithfulTokens
                      ? row.text
                      : tokens.map((token, index) => (
                          <span
                            key={token.offset}
                            className="review-diff-token"
                            style={syntaxTokenStyle(token)}
                          >
                            {index === 0
                              ? `${row.text[0]}${token.content}`
                              : token.content}
                          </span>
                        ))}
                  </code>
                </td>
              </>
            )}
          </tr>
        )
      })}
    </tbody>
  )
}
