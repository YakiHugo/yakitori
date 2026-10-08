import { describe, expect, it } from "vitest"
import { citationSources } from "../../src/gui/citation-sources.ts"
import type { JsonObject, ModelTextBlock } from "../../src/kernel/events.ts"

describe("citation sources", () => {
  it("lists sources from all three providers and deduplicates URLs without changing native annotations", () => {
    const citation = {
      type: "url_citation",
      title: "Shared source",
      url: "https://example.com/source",
      start_index: 1,
      end_index: 4,
    }
    const blocks: ModelTextBlock[] = [
      openaiBlock("First answer", [citation, citation]),
      {
        type: "text",
        text: "Next",
        providerMetadata: {
          chatCompletions: {
            annotations: [
              { type: "url_citation", url_citation: citation },
              {
                type: "url_citation",
                url_citation: { ...citation, start_index: 0, end_index: 1 },
              },
            ],
          },
        },
      },
      {
        type: "text",
        text: "Last answer",
        providerMetadata: {
          anthropic: {
            citations: [
              {
                type: "web_search_result_location",
                title: "Shared source",
                url: "https://example.com/source",
                cited_text: "Last",
                encrypted_index: "private-index",
              },
            ],
          },
        },
      },
    ]
    const original = structuredClone(blocks)

    expect(sourceDetails(blocks)).toEqual([
      {
        label: "Shared source",
        url: "https://example.com/source",
      },
    ])
    expect(blocks).toEqual(original)
  })

  it("keeps distinct stable row identities for different local citations sharing a title", () => {
    const blocks = [
      openaiBlock("Answer", [
        { type: "file_citation", filename: "report.pdf", file_id: "private-a" },
        { type: "file_citation", filename: "report.pdf", file_id: "private-b" },
      ]),
    ]
    const first = citationSources(blocks)
    expect(first).toHaveLength(2)
    expect(new Set(first.map((source) => source.id)).size).toBe(2)
    expect(citationSources(blocks).map((source) => source.id)).toEqual(
      first.map((source) => source.id),
    )
    expect(JSON.stringify(first)).not.toContain("private-")
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
        openaiBlock("Answer", [
          { type: "url_citation", title: "Named source", url },
        ]),
      ]),
    ).toEqual([
      {
        label: "Named source",
      },
    ])
  })

  it("uses parsed HTTP URLs and a hostname fallback for untitled sources", () => {
    expect(
      sourceDetails([
        openaiBlock("Answer", [
          { type: "url_citation", url: "HTTP://EXAMPLE.COM:80/a" },
        ]),
        {
          type: "text",
          text: "More",
          providerMetadata: {
            anthropic: {
              citations: [
                {
                  type: "search_result_location",
                  title: " Result ",
                  source: "https://example.com/result",
                },
              ],
            },
          },
        },
      ]),
    ).toEqual([
      {
        label: "example.com",
        url: "http://example.com/a",
      },
      {
        label: "Result",
        url: "https://example.com/result",
      },
    ])
  })

  it("shows local file and document provenance without exposing provider identifiers or inventing URLs", () => {
    const blocks: ModelTextBlock[] = [
      openaiBlock("Answer", [
        {
          type: "file_citation",
          filename: "/private/reports/report.pdf",
          file_id: "private-file",
        },
        {
          type: "container_file_citation",
          filename: "C:\\private\\notes.txt",
          container_id: "private-container",
        },
        {
          type: "file_path",
          file_path: "/private/output.csv",
          file_id: "private-output",
        },
        { type: "file_citation", file_id: "private-unnamed" },
      ]),
      {
        type: "text",
        text: "Quote",
        providerMetadata: {
          anthropic: {
            citations: [
              {
                type: "page_location",
                document_title: " Report ",
                document_index: 3,
                start_page_number: 2,
                end_page_number: 4,
                file_id: "private-file",
                encrypted_index: "private-index",
                cited_text: "private quotation",
              },
              {
                type: "char_location",
                document_title: "Report",
                start_char_index: 100,
                end_char_index: 200,
              },
              {
                type: "content_block_location",
                document_index: 4,
                start_block_index: 0,
                end_block_index: 1,
              },
            ],
          },
        },
      },
    ]
    const original = structuredClone(blocks)

    expect(sourceDetails(blocks)).toEqual([
      { label: "report.pdf" },
      { label: "notes.txt" },
      { label: "output.csv" },
      { label: "File source" },
      {
        label: "Report",
        location: "from page 2",
      },
      { label: "Report" },
      { label: "Document source" },
    ])
    expect(blocks).toEqual(original)
  })

  it("ignores absent, malformed, and unknown provider metadata", () => {
    expect(
      sourceDetails([
        { type: "text", text: "No metadata" },
        {
          type: "text",
          text: "Malformed",
          providerMetadata: {
            openai: { part: null },
            anthropic: { citations: {} },
            chatCompletions: false,
          },
        },
        openaiBlock("Unknown", [
          null,
          false,
          {
            type: "unknown",
            url: "https://example.com/",
            encrypted_index: "private-index",
          },
        ]),
      ]),
    ).toEqual([])
  })
})

function openaiBlock(
  text: string,
  annotations: JsonObject["annotations"],
): ModelTextBlock {
  return {
    type: "text",
    text,
    providerMetadata: { openai: { part: { annotations } } },
  }
}

function sourceDetails(blocks: readonly ModelTextBlock[]) {
  return citationSources(blocks).map(({ id: _id, ...details }) => details)
}
