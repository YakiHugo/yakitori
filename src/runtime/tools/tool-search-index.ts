import type { JsonValue } from "../../kernel/index.ts"
import type { ModelToolDefinition } from "../model.ts"
import type { ToolSearchMetadata } from "./types.ts"

type SearchDocument = Readonly<{
  definition: ModelToolDefinition
  canonicalName: string
  bareName: string
  length: number
  termFrequency: ReadonlyMap<string, number>
}>

export type ToolSearchDocument = Readonly<{
  definition: ModelToolDefinition
  metadata?: ToolSearchMetadata
}>

export type ToolSearchIndex = Readonly<{
  search(query: string, limit: number): readonly ModelToolDefinition[]
}>

const BM25_K1 = 1.2
const BM25_B = 0.75

export function createToolSearchIndex(
  entries: readonly ToolSearchDocument[],
): ToolSearchIndex {
  const documents = entries.map(({ definition, metadata }) => {
    const terms = tokenize(
      [
        definition.name,
        splitIdentifier(definition.name),
        definition.description,
        schemaSearchText(definition.inputSchema),
        metadata?.searchText,
        metadata?.source,
      ]
        .filter((part): part is string => part !== undefined)
        .join(" "),
    )
    const termFrequency = new Map<string, number>()
    for (const term of terms) {
      termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1)
    }
    return {
      definition,
      canonicalName: definition.name.toLowerCase(),
      bareName: (
        definition.name.split("__").at(-1) ?? definition.name
      ).toLowerCase(),
      length: terms.length,
      termFrequency,
    }
  })
  const documentFrequency = new Map<string, number>()
  for (const document of documents) {
    for (const term of document.termFrequency.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
    }
  }
  const averageLength =
    documents.length === 0
      ? 0
      : documents.reduce((sum, document) => sum + document.length, 0) /
        documents.length

  return {
    search(query, limit) {
      const normalized = query.trim().toLowerCase()
      if (normalized.length === 0 || documents.length === 0) return []

      const exact = documents.filter(
        (document) =>
          document.canonicalName === normalized ||
          document.bareName === normalized,
      )
      if (exact.length > 0) {
        return exact.slice(0, limit).map((document) => document.definition)
      }

      const queryTerms = [...new Set(tokenize(query))]
      if (queryTerms.length === 0) return []
      return documents
        .map((document, index) => ({
          document,
          index,
          score: queryTerms.reduce(
            (score, term) =>
              score +
              bm25TermScore(
                term,
                document,
                documents.length,
                documentFrequency.get(term) ?? 0,
                averageLength,
              ),
            0,
          ),
        }))
        .filter((candidate) => candidate.score > 0)
        .sort(
          (left, right) => right.score - left.score || left.index - right.index,
        )
        .slice(0, limit)
        .map((candidate) => candidate.document.definition)
    },
  }
}

function bm25TermScore(
  term: string,
  document: SearchDocument,
  documentCount: number,
  matchingDocuments: number,
  averageLength: number,
): number {
  const frequency = document.termFrequency.get(term) ?? 0
  if (frequency === 0 || matchingDocuments === 0) return 0
  const inverseDocumentFrequency = Math.log(
    1 + (documentCount - matchingDocuments + 0.5) / (matchingDocuments + 0.5),
  )
  const normalizedLength =
    averageLength === 0 ? 1 : document.length / averageLength
  return (
    inverseDocumentFrequency *
    ((frequency * (BM25_K1 + 1)) /
      (frequency + BM25_K1 * (1 - BM25_B + BM25_B * normalizedLength)))
  )
}

function tokenize(value: string): string[] {
  return (
    splitIdentifier(value)
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  )
}

function splitIdentifier(value: string): string {
  return value
    .replaceAll("__", " ")
    .replaceAll(/[_-]+/gu, " ")
    .replaceAll(/([\p{Ll}\d])([\p{Lu}])/gu, "$1 $2")
}

function schemaSearchText(schema: JsonValue): string {
  const parts: string[] = []
  visitSchema(schema, parts)
  return parts.join(" ")
}

function visitSchema(value: JsonValue, parts: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) visitSchema(item, parts)
    return
  }
  if (typeof value !== "object" || value === null) return
  for (const [key, child] of Object.entries(value)) {
    if (key === "description" || key === "title") {
      if (typeof child === "string") parts.push(child)
      continue
    }
    if (key === "properties" && isJsonRecord(child)) {
      for (const [property, propertySchema] of Object.entries(child)) {
        parts.push(property, splitIdentifier(property))
        visitSchema(propertySchema, parts)
      }
      continue
    }
    visitSchema(child, parts)
  }
}

function isJsonRecord(
  value: JsonValue,
): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
