import { memo, useMemo } from "react"
import {
  languageForPath,
  syntaxTokenStyle,
  useSyntaxTokens,
} from "../lib/syntax-highlighter.ts"
import "./source-code.css"

export const SourceCode = memo(function SourceCode({
  code,
  path,
  offset = 1,
  wrap = false,
  className,
}: Readonly<{
  code: string
  path: string
  offset?: number
  wrap?: boolean
  className?: string
}>) {
  const language = languageForPath(path)
  const tokens = useSyntaxTokens(code, language)
  const lines = useMemo(() => code.split("\n"), [code])
  return (
    <div
      className={`source-code${className ? ` ${className}` : ""}`}
      data-wrap={wrap}
      data-language={language ?? "text"}
    >
      <table
        aria-label={`Source code for ${path}`}
        className="source-code-table"
      >
        <tbody>
          {lines.map((line, index) => {
            const highlighted = tokens?.[index]
            const content = line.endsWith("\r") ? line.slice(0, -1) : line
            // Preserve exact source, including CRLF and blank lines, even if a
            // grammar normalizes a character or returns a different line shape.
            const faithful =
              highlighted?.map((token) => token.content).join("") === content
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: source lines are ordered positions
              <tr key={index} className="source-code-line">
                <td className="source-code-number">{offset + index}</td>
                <td className="source-code-content">
                  <code>
                    {faithful ? (
                      <>
                        {highlighted?.map((token) => (
                          <span
                            key={token.offset}
                            className="source-code-token"
                            style={syntaxTokenStyle(token)}
                          >
                            {token.content}
                          </span>
                        ))}
                        {line.slice(content.length)}
                      </>
                    ) : (
                      line
                    )}
                  </code>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
})
