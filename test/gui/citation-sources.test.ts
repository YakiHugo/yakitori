import { describe, expect, it } from "vitest"
import { citationSources } from "../../src/gui/citation-sources.ts"
import type {
  ModelAssistantTextBlock,
  ModelCitation,
} from "../../src/protocol/conversation.ts"

describe("citation sources", () => {
  it("deduplicates the same web source across claims and text blocks", () => {
    const source = {
      kind: "url",
      title: "Shared source",
      url: "https://example.com/source",
    } as const
    const blocks = [
      answer("First claim", [
        { ...source, responseSpan: { start: 0, end: 4 } },
        { ...source, responseSpan: { start: 4, end: 10 } },
      ]),
      answer("Last claim", [{ ...source, citedText: "Quoted from source" }]),
    ]
    expect(sourceDetails(blocks)).toEqual([
      { label: "Shared source", url: "https://example.com/source" },
    ])
  })

  it("keeps stable row identities for different local citations sharing a title", () => {
    const blocks = [
      answer("Answer", [
        { kind: "file", title: "report.pdf" },
        { kind: "file", title: "report.pdf" },
      ]),
    ]
    const first = citationSources(blocks)
    expect(first).toHaveLength(2)
    expect(new Set(first.map((source) => source.id)).size).toBe(2)
    expect(citationSources(blocks)).toEqual(first)
  })

  it.each([
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "file:///private/report.pdf",
    "https://user:password@example.com/",
    "https://user@example.com/",
    "https://example.com/\npath",
    "https://example.com/\tpath",
    "https://example.com/\u007fpath",
    "https://",
    "//example.com/path",
    "/relative/path",
  ])("keeps an unsafe or malformed URL non-clickable: %j", (url) => {
    expect(
      sourceDetails([
        answer("Answer", [{ kind: "url", title: "Named source", url }]),
      ]),
    ).toEqual([{ label: "Named source" }])
  })

  it("uses the parsed HTTP URL and a hostname fallback for untitled sources", () => {
    expect(
      sourceDetails([
        answer("Answer", [{ kind: "url", url: "HTTP://EXAMPLE.COM:80/a" }]),
        answer("More", [
          { kind: "url", title: " Result ", url: "https://example.com/result" },
        ]),
      ]),
    ).toEqual([
      { label: "example.com", url: "http://example.com/a" },
      { label: "Result", url: "https://example.com/result" },
    ])
  })

  it("uses file basenames and source pages for local and document labels", () => {
    const blocks = [
      answer("Answer", [
        { kind: "file", title: "/private/reports/report.pdf" },
        { kind: "file", title: "C:\\private\\notes.txt" },
        { kind: "file" },
      ]),
      answer("Quote", [
        {
          kind: "document",
          title: " Report ",
          sourceLocation: { unit: "page", start: 2, end: 4 },
        },
        {
          kind: "document",
          title: "Report",
          sourceLocation: { unit: "character", start: 100, end: 200 },
        },
        { kind: "document" },
      ]),
    ]
    expect(sourceDetails(blocks)).toEqual([
      { label: "report.pdf" },
      { label: "notes.txt" },
      { label: "File source" },
      { label: "Report", location: "from page 2" },
      { label: "Report" },
      { label: "Document source" },
    ])
  })
})

function answer(
  text: string,
  annotations: readonly ModelCitation[],
): ModelAssistantTextBlock {
  return { type: "text", text, annotations }
}

function sourceDetails(blocks: readonly ModelAssistantTextBlock[]) {
  return citationSources(blocks).map(({ id: _id, ...details }) => details)
}
