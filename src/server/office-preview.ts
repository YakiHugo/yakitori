import { posix } from "node:path"
import { SaxesParser } from "saxes"
import { type Entry, fromBufferPromise, type ZipFile } from "yauzl"

export type WorkspaceReadOfficeResponse =
  | {
      path: string
      kind: "docx"
      blocks: (
        | { kind: "paragraph"; text: string }
        | { kind: "table"; rows: string[][] }
      )[]
      truncated: boolean
    }
  | {
      path: string
      kind: "xlsx"
      sheets: { name: string; rows: string[][] }[]
      truncated: boolean
    }
  | {
      path: string
      kind: "pptx"
      slides: { number: number; paragraphs: string[]; notes: string[] }[]
      truncated: boolean
    }

export class OfficePreviewError extends Error {}

const OFFICE_RELATIONSHIPS_NAMESPACE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const MARKUP_COMPATIBILITY_NAMESPACE =
  "http://schemas.openxmlformats.org/markup-compatibility/2006"

// Implementation safety bounds: ZIP metadata, expanded XML and returned
// structures must fit comfortably inside one server request.
const MAX_ENTRIES = 2_048
const MAX_ENTRY_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_BYTES = 12 * 1024 * 1024
const MAX_BLOCKS = 300
const MAX_SHEETS = 12
const MAX_ROWS = 200
const MAX_COLUMNS = 64
const MAX_SLIDES = 100
const MAX_PARAGRAPHS = 100
const MAX_XML_DEPTH = 128
const MAX_XML_NODES = 100_000
const MAX_OUTPUT_CHARACTERS = 256 * 1024

class OutputBudget {
  truncated = false
  private remaining = MAX_OUTPUT_CHARACTERS

  take(value: string): string {
    const part = value.slice(0, this.remaining)
    this.remaining -= part.length
    if (part.length !== value.length) this.truncated = true
    return part
  }
}

type XmlNode = {
  name: string
  namespace: string
  attributes: Record<string, string>
  children: XmlNode[]
  text: string
}

function parseXml(xml: string): XmlNode {
  const root: XmlNode = {
    name: "",
    namespace: "",
    attributes: {},
    children: [],
    text: "",
  }
  const stack = [root]
  let nodeCount = 0
  const parser = new SaxesParser({ xmlns: true })
  parser.on("doctype", () => {
    throw new OfficePreviewError("Office XML must not contain a document type.")
  })
  parser.on("opentag", (tag) => {
    if (stack.length > MAX_XML_DEPTH || ++nodeCount > MAX_XML_NODES)
      throw new OfficePreviewError(
        "Office XML exceeds the structure safety limit.",
      )
    const attributes: Record<string, string> = {}
    for (const attribute of Object.values(tag.attributes)) {
      attributes[attribute.name] = attribute.value
      if (attribute.uri)
        attributes[`{${attribute.uri}}${attribute.local}`] = attribute.value
    }
    const node: XmlNode = {
      name: tag.local,
      namespace: tag.uri,
      attributes,
      children: [],
      text: "",
    }
    stack.at(-1)?.children.push(node)
    stack.push(node)
  })
  parser.on("closetag", () => {
    stack.pop()
  })
  parser.on("text", (text) => {
    const node = stack.at(-1)
    if (node) node.text += text
  })
  try {
    parser.write(xml).close()
  } catch (error) {
    if (error instanceof OfficePreviewError) throw error
    if (error instanceof Error)
      throw new OfficePreviewError(`Malformed Office XML: ${error.message}`)
    throw error
  }
  return root.children[0] ?? root
}

function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name)
}

function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((entry) => entry.name === name)
}

function descendants(node: XmlNode, name: string): XmlNode[] {
  return node.children.flatMap((entry) => [
    ...(entry.name === name ? [entry] : []),
    ...descendants(entry, name),
  ])
}

function text(node: XmlNode): string {
  return node.text + node.children.map(text).join("")
}

function attr(node: XmlNode, name: string): string | undefined {
  return Object.entries(node.attributes).find(
    ([key]) => key === name || key.endsWith(`:${name}`),
  )?.[1]
}

function relationshipId(node: XmlNode): string | undefined {
  return node.attributes[`{${OFFICE_RELATIONSHIPS_NAMESPACE}}id`]
}

function wordContent(nodes: XmlNode[]): XmlNode[] {
  return nodes.flatMap((node) => {
    if (
      node.namespace !== MARKUP_COMPATIBILITY_NAMESPACE ||
      node.name !== "AlternateContent"
    )
      return [node]
    // Prefer the broadly readable fallback when the Choice's Requires
    // namespaces depend on Word extensions this preview does not implement.
    const branch = child(node, "Fallback") ?? child(node, "Choice")
    return branch ? wordContent(branch.children) : []
  })
}

function resolvePart(owner: string, target: string): string {
  if (!target || target.includes("\\") || target.includes("\0"))
    throw new OfficePreviewError("Invalid Office relationship target.")
  const path = posix.normalize(
    target.startsWith("/")
      ? target.slice(1)
      : posix.join(posix.dirname(owner), target),
  )
  if (path === ".." || path.startsWith("../") || path.startsWith("/"))
    throw new OfficePreviewError("Office relationship escapes the archive.")
  return path
}

function relationships(node: XmlNode, owner: string): Map<string, string> {
  const results = new Map<string, string>()
  for (const rel of children(node, "Relationship")) {
    const id = attr(rel, "Id")
    const target = attr(rel, "Target")
    if (id && target && attr(rel, "TargetMode") !== "External")
      results.set(id, resolvePart(owner, target))
  }
  return results
}

class OfficeArchive {
  private readonly entries = new Map<string, Entry>()
  private expandedBytes = 0
  private readonly zip: ZipFile

  constructor(zip: ZipFile) {
    this.zip = zip
  }

  async index(): Promise<void> {
    if (this.zip.entryCount > MAX_ENTRIES)
      throw new OfficePreviewError("Office archive has too many entries.")
    try {
      for await (const entry of this.zip.eachEntry()) {
        const name = entry.fileName
        if (
          name.startsWith("/") ||
          name.includes("\\") ||
          name.split("/").includes("..") ||
          this.entries.has(name)
        )
          throw new OfficePreviewError(
            "Office archive contains an unsafe entry.",
          )
        this.entries.set(name, entry)
      }
    } catch (error) {
      if (error instanceof OfficePreviewError) throw error
      if (error instanceof Error)
        throw new OfficePreviewError(`Invalid Office archive: ${error.message}`)
      throw error
    }
  }

  async xml(name: string, optional = false): Promise<XmlNode | undefined> {
    const entry = this.entries.get(name)
    if (!entry) {
      if (optional) return
      throw new OfficePreviewError(`Office archive is missing ${name}.`)
    }
    if (entry.uncompressedSize > MAX_ENTRY_BYTES)
      throw new OfficePreviewError("Office XML exceeds the entry safety limit.")
    if (this.expandedBytes + entry.uncompressedSize > MAX_TOTAL_BYTES)
      throw new OfficePreviewError(
        "Office XML exceeds the request safety limit.",
      )
    const chunks: Buffer[] = []
    let size = 0
    try {
      const stream = await this.zip.openReadStreamPromise(entry)
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += bytes.length
        if (
          size > MAX_ENTRY_BYTES ||
          this.expandedBytes + size > MAX_TOTAL_BYTES
        ) {
          stream.destroy()
          throw new OfficePreviewError("Office XML exceeds the safety limit.")
        }
        chunks.push(bytes)
      }
    } catch (error) {
      if (error instanceof OfficePreviewError) throw error
      if (error instanceof Error)
        throw new OfficePreviewError(
          `Invalid Office ZIP entry: ${error.message}`,
        )
      throw error
    }
    this.expandedBytes += size
    let xml: string
    try {
      xml = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, size),
      )
    } catch (error) {
      if (error instanceof TypeError)
        throw new OfficePreviewError("Office XML is not valid UTF-8.")
      throw error
    }
    return parseXml(xml)
  }
}

function documentText(node: XmlNode): string {
  let value = ""
  function visit(current: XmlNode): void {
    if (current.name === "t") value += text(current)
    else if (current.name === "tab") value += "\t"
    else if (current.name === "br" || current.name === "cr") value += "\n"
    else for (const part of wordContent(current.children)) visit(part)
  }
  visit(node)
  return value
}

async function docx(
  archive: OfficeArchive,
  path: string,
): Promise<WorkspaceReadOfficeResponse> {
  const output = new OutputBudget()
  const document = await archive.xml("word/document.xml")
  if (!document) throw new OfficePreviewError("Missing Word document.")
  const body = child(document, "body")
  if (!body) throw new OfficePreviewError("Missing Word document body.")
  const blocks: Extract<
    WorkspaceReadOfficeResponse,
    { kind: "docx" }
  >["blocks"] = []
  let truncated = false
  for (const block of wordContent(body.children)) {
    if (block.name !== "p" && block.name !== "tbl") continue
    if (blocks.length === MAX_BLOCKS) {
      truncated = true
      break
    }
    if (block.name === "p")
      blocks.push({ kind: "paragraph", text: output.take(documentText(block)) })
    else {
      const rows = children(block, "tr")
        .slice(0, MAX_ROWS)
        .map((row) =>
          children(row, "tc")
            .slice(0, MAX_COLUMNS)
            .map((cell) =>
              output.take(
                wordContent(cell.children)
                  .filter((node) => node.name === "p")
                  .map(documentText)
                  .join("\n"),
              ),
            ),
        )
      if (
        children(block, "tr").length > MAX_ROWS ||
        children(block, "tr").some(
          (row) => children(row, "tc").length > MAX_COLUMNS,
        )
      )
        truncated = true
      blocks.push({ kind: "table", rows })
    }
  }
  return {
    path,
    kind: "docx",
    blocks,
    truncated: truncated || output.truncated,
  }
}

async function xlsx(
  archive: OfficeArchive,
  path: string,
): Promise<WorkspaceReadOfficeResponse> {
  const output = new OutputBudget()
  const workbook = await archive.xml("xl/workbook.xml")
  const rels = await archive.xml("xl/_rels/workbook.xml.rels")
  if (!workbook || !rels)
    throw new OfficePreviewError("Missing Excel workbook.")
  const sheetRels = relationships(rels, "xl/workbook.xml")
  const sharedXml = await archive.xml("xl/sharedStrings.xml", true)
  const shared = sharedXml
    ? children(sharedXml, "si").map((item) =>
        descendants(item, "t").map(text).join(""),
      )
    : []
  const sheetNodes = descendants(workbook, "sheet")
  const sheets: Extract<
    WorkspaceReadOfficeResponse,
    { kind: "xlsx" }
  >["sheets"] = []
  let truncated = sheetNodes.length > MAX_SHEETS
  for (const sheet of sheetNodes.slice(0, MAX_SHEETS)) {
    const id = relationshipId(sheet)
    const target = id && sheetRels.get(id)
    if (!target)
      throw new OfficePreviewError("Excel worksheet relationship is missing.")
    const worksheet = await archive.xml(target)
    if (!worksheet) throw new OfficePreviewError("Missing Excel worksheet.")
    const rowNodes = descendants(worksheet, "sheetData").flatMap((data) =>
      children(data, "row"),
    )
    const rows: string[][] = []
    let previousRow = 0
    for (const row of rowNodes) {
      const rowIndex = Number(attr(row, "r"))
      if (!Number.isSafeInteger(rowIndex) || rowIndex <= previousRow)
        throw new OfficePreviewError(
          "Invalid or out-of-order Excel row reference.",
        )
      previousRow = rowIndex
      if (rowIndex > MAX_ROWS) {
        truncated = true
        continue
      }
      while (rows.length < rowIndex - 1) rows.push([])
      const values: string[] = []
      const seenColumns = new Set<number>()
      for (const cell of children(row, "c")) {
        const reference = attr(cell, "r")
        const match = reference?.match(/^([A-Z]+)([1-9][0-9]*)$/)
        if (!match || Number(match[2]) !== rowIndex)
          throw new OfficePreviewError("Invalid Excel cell reference.")
        let index = 0
        for (const letter of match[1] ?? "")
          index = index * 26 + letter.charCodeAt(0) - 64
        if (seenColumns.has(index))
          throw new OfficePreviewError("Duplicate Excel cell reference.")
        seenColumns.add(index)
        if (index > MAX_COLUMNS) {
          truncated = true
          continue
        }
        const type = attr(cell, "t")
        const raw = child(cell, "v")
        let value =
          type === "inlineStr"
            ? descendants(cell, "is")
                .flatMap((item) => descendants(item, "t"))
                .map(text)
                .join("")
            : raw
              ? text(raw)
              : ""
        if (type === "s") {
          const sharedIndex = Number(value)
          if (
            !Number.isSafeInteger(sharedIndex) ||
            sharedIndex < 0 ||
            sharedIndex >= shared.length
          )
            throw new OfficePreviewError("Invalid Excel shared string index.")
          value = shared[sharedIndex] ?? ""
        }
        if (type === "b") {
          if (value !== "0" && value !== "1")
            throw new OfficePreviewError("Invalid Excel boolean cell.")
          value = value === "1" ? "TRUE" : "FALSE"
        }
        values[index - 1] = output.take(value)
      }
      rows.push(
        Array.from(
          { length: values.length },
          (_, index) => values[index] ?? "",
        ),
      )
    }
    sheets.push({ name: output.take(attr(sheet, "name") ?? ""), rows })
  }
  return {
    path,
    kind: "xlsx",
    sheets,
    truncated: truncated || output.truncated,
  }
}

function drawingParagraphs(node: XmlNode): string[] {
  return descendants(node, "p")
    .map((paragraph) => descendants(paragraph, "t").map(text).join(""))
    .filter((value) => value.length > 0)
}

async function pptx(
  archive: OfficeArchive,
  path: string,
): Promise<WorkspaceReadOfficeResponse> {
  const output = new OutputBudget()
  const presentation = await archive.xml("ppt/presentation.xml")
  const rels = await archive.xml("ppt/_rels/presentation.xml.rels")
  if (!presentation || !rels)
    throw new OfficePreviewError("Missing PowerPoint presentation.")
  const slideRels = relationships(rels, "ppt/presentation.xml")
  const slideNodes = descendants(presentation, "sldId")
  const slides: Extract<
    WorkspaceReadOfficeResponse,
    { kind: "pptx" }
  >["slides"] = []
  let truncated = slideNodes.length > MAX_SLIDES
  for (const slideNode of slideNodes.slice(0, MAX_SLIDES)) {
    const id = relationshipId(slideNode)
    const target = id && slideRels.get(id)
    if (!target)
      throw new OfficePreviewError("PowerPoint slide relationship is missing.")
    const slide = await archive.xml(target)
    if (!slide) throw new OfficePreviewError("Missing PowerPoint slide.")
    const paragraphs = drawingParagraphs(slide)
    const relPath = posix.join(
      posix.dirname(target),
      "_rels",
      `${posix.basename(target)}.rels`,
    )
    const slideRelXml = await archive.xml(relPath, true)
    const notesPart = slideRelXml
      ? [...relationships(slideRelXml, target).values()].find((part) =>
          /^ppt\/notesSlides\/notesSlide[^/]*\.xml$/.test(part),
        )
      : undefined
    const notesXml = notesPart ? await archive.xml(notesPart) : undefined
    const notes = notesXml
      ? descendants(notesXml, "sp")
          .filter((shape) =>
            descendants(shape, "ph").some((ph) => attr(ph, "type") === "body"),
          )
          .flatMap(drawingParagraphs)
      : []
    if (paragraphs.length > MAX_PARAGRAPHS || notes.length > MAX_PARAGRAPHS)
      truncated = true
    slides.push({
      number: slides.length + 1,
      paragraphs: paragraphs
        .slice(0, MAX_PARAGRAPHS)
        .map((value) => output.take(value)),
      notes: notes.slice(0, MAX_PARAGRAPHS).map((value) => output.take(value)),
    })
  }
  return {
    path,
    kind: "pptx",
    slides,
    truncated: truncated || output.truncated,
  }
}

export async function parseOfficePreview(input: {
  bytes: Buffer
  path: string
  kind: WorkspaceReadOfficeResponse["kind"]
}): Promise<WorkspaceReadOfficeResponse> {
  // yauzl validates ZIP directory records and entry sizes while lazily
  // streaming only the parts selected by the workbook/presentation metadata.
  let zip: ZipFile
  try {
    zip = await fromBufferPromise(input.bytes, {
      lazyEntries: true,
      autoClose: false,
      validateEntrySizes: true,
    })
  } catch (error) {
    if (error instanceof Error)
      throw new OfficePreviewError(`Invalid Office archive: ${error.message}`)
    throw error
  }
  try {
    const archive = new OfficeArchive(zip)
    await archive.index()
    switch (input.kind) {
      case "docx":
        return await docx(archive, input.path)
      case "xlsx":
        return await xlsx(archive, input.path)
      case "pptx":
        return await pptx(archive, input.path)
    }
  } finally {
    zip.close()
  }
}
