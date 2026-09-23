import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { ZipFile } from "yazl"
import type { WorkspaceReadOfficeResponse } from "../../../src/server/office-preview.ts"
import {
  createFakeHandlers,
  createTestProcessor,
  initializeConnection,
  openTestConnection,
} from "./testkit.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "yakitori-office-"))
  roots.push(root)
  const cwd = join(root, "project")
  await mkdir(cwd)
  const { processor } = createTestProcessor({ handlers: createFakeHandlers() })
  const connection = openTestConnection(processor)
  await initializeConnection(connection)
  return { root, cwd, connection }
}

async function zip(entries: Record<string, string>): Promise<Buffer> {
  const file = new ZipFile()
  for (const [name, content] of Object.entries(entries))
    file.addBuffer(Buffer.from(content), name)
  file.end()
  const chunks: Buffer[] = []
  for await (const chunk of file.outputStream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

it("reads Word paragraphs and table cells in document order with split text runs", async () => {
  const { cwd, connection } = await setup()
  await writeFile(
    join(cwd, "report.docx"),
    await zip({
      "[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
      "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
      <w:p><w:r><w:t>Hel</w:t></w:r><w:r><w:t>lo &amp; goodbye</w:t></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc>
      <w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p><w:p><w:r><w:t>second line</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      <mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">
        <mc:Choice Requires="w14"><w:p><w:r><w:t>Extension text</w:t></w:r></w:p></mc:Choice>
        <mc:Fallback><w:p><w:r><w:t>Fallback text</w:t></w:r></w:p></mc:Fallback>
      </mc:AlternateContent>
      <w:p><w:r><w:t>After</w:t></w:r><w:r><w:tab/><w:t>table</w:t></w:r></w:p>
    </w:body></w:document>`,
    }),
  )
  expect(
    await connection.sendRequest("workspace/readOffice", {
      cwd,
      path: "report.docx",
    }),
  ).toMatchObject({
    result: {
      path: "report.docx",
      kind: "docx",
      truncated: false,
      blocks: [
        { kind: "paragraph", text: "Hello & goodbye" },
        { kind: "table", rows: [["A1", "B1\nsecond line"]] },
        { kind: "paragraph", text: "Fallback text" },
        { kind: "paragraph", text: "After\ttable" },
      ],
    } satisfies WorkspaceReadOfficeResponse,
  })
})

it("uses workbook sheet order and resolves shared, inline, numeric and boolean cells", async () => {
  const { cwd, connection } = await setup()
  await writeFile(
    join(cwd, "ledger.xlsx"),
    await zip({
      "[Content_Types].xml": "<Types/>",
      "xl/workbook.xml": `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
      xmlns:rel="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>
      <sheet name="First" sheetId="8" rel:id="rId2"/><sheet name="Last" sheetId="1" rel:id="rId1"/>
      </sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>
      <Relationship Id="rId2" Type="worksheet" Target="/xl/worksheets/sheet8.xml"/></Relationships>`,
      "xl/sharedStrings.xml": `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <si><r><t>Sha</t></r><r><t>red</t></r></si></sst>`,
      "xl/worksheets/sheet8.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
      <row r="1"><c r="B1" t="s"><v>0</v></c><c r="A1" t="inlineStr"><is><t>Inline</t></is></c></row>
      <row r="3"><c r="A3"><v>42.5</v></c><c r="C3" t="b"><v>1</v></c></row>
      </sheetData></worksheet>`,
      "xl/worksheets/sheet1.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
      <row r="1"><c r="A1"><v>Tail</v></c></row></sheetData></worksheet>`,
    }),
  )
  expect(
    await connection.sendRequest("workspace/readOffice", {
      cwd,
      path: "ledger.xlsx",
    }),
  ).toMatchObject({
    result: {
      path: "ledger.xlsx",
      kind: "xlsx",
      truncated: false,
      sheets: [
        {
          name: "First",
          rows: [["Inline", "Shared"], [], ["42.5", "", "TRUE"]],
        },
        { name: "Last", rows: [["Tail"]] },
      ],
    } satisfies WorkspaceReadOfficeResponse,
  })
})

it("uses presentation slide order and each slide's own notes relationship", async () => {
  const { cwd, connection } = await setup()
  await writeFile(
    join(cwd, "deck.pptx"),
    await zip({
      "[Content_Types].xml": "<Types/>",
      "ppt/presentation.xml": `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
      xmlns:rel="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <p:sldIdLst><p:sldId id="257" rel:id="rId7"/><p:sldId id="256" rel:id="rId3"/></p:sldIdLst></p:presentation>`,
      "ppt/_rels/presentation.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId3" Type="slide" Target="slides/slide1.xml"/>
      <Relationship Id="rId7" Type="slide" Target="slides/slide10.xml"/></Relationships>`,
      "ppt/slides/slide10.xml": `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
      xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>
      <p:sp><p:txBody><a:p><a:r><a:t>Fir</a:t></a:r><a:r><a:t>st &amp; foremost</a:t></a:r></a:p></p:txBody></p:sp>
      </p:spTree></p:cSld></p:sld>`,
      "ppt/slides/slide1.xml": `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
      xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>
      <p:sp><p:txBody><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:txBody></p:sp>
      </p:spTree></p:cSld></p:sld>`,
      "ppt/slides/_rels/slide10.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="notesSlide" Target="../notesSlides/notesSlide4.xml"/></Relationships>`,
      "ppt/notesSlides/notesSlide4.xml": `<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
      xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>
      <p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Speaker note</a:t></a:r></a:p></p:txBody></p:sp>
      <p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>4</a:t></a:r></a:p></p:txBody></p:sp>
      </p:spTree></p:cSld></p:notes>`,
    }),
  )
  expect(
    await connection.sendRequest("workspace/readOffice", {
      cwd,
      path: "deck.pptx",
    }),
  ).toMatchObject({
    result: {
      path: "deck.pptx",
      kind: "pptx",
      truncated: false,
      slides: [
        {
          number: 1,
          paragraphs: ["First & foremost"],
          notes: ["Speaker note"],
        },
        { number: 2, paragraphs: ["Second"], notes: [] },
      ],
    } satisfies WorkspaceReadOfficeResponse,
  })
})

it("bounds sparse worksheet coordinates and rejects duplicate cells", async () => {
  const { cwd, connection } = await setup()
  const base = {
    "xl/workbook.xml": `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet" r:id="r1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>`,
  }
  await writeFile(
    join(cwd, "sparse.xlsx"),
    await zip({
      ...base,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1"><v>start</v></c></row>
      <row r="201"><c r="A201"><v>outside preview</v></c></row></sheetData></worksheet>`,
    }),
  )
  expect(
    await connection.sendRequest("workspace/readOffice", {
      cwd,
      path: "sparse.xlsx",
    }),
  ).toMatchObject({
    result: {
      kind: "xlsx",
      truncated: true,
      sheets: [{ name: "Sheet", rows: [["start"]] }],
    },
  })
  await writeFile(
    join(cwd, "duplicate.xlsx"),
    await zip({
      ...base,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1"><v>one</v></c><c r="A1"><v>two</v></c></row></sheetData></worksheet>`,
    }),
  )
  expect(
    await connection.sendRequest("workspace/readOffice", {
      cwd,
      path: "duplicate.xlsx",
    }),
  ).toMatchObject({ error: { data: { code: "invalid_input" } } })
})

it("bounds the returned text when a shared string is repeated across cells", async () => {
  const { cwd, connection } = await setup()
  const rows = Array.from(
    { length: 200 },
    (_, index) =>
      `<row r="${index + 1}"><c r="A${index + 1}" t="s"><v>0</v></c></row>`,
  ).join("")
  await writeFile(
    join(cwd, "repeated.xlsx"),
    await zip({
      "xl/workbook.xml": `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet" r:id="r1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/sharedStrings.xml": `<sst><si><t>${"x".repeat(2_000)}</t></si></sst>`,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${rows}</sheetData></worksheet>`,
    }),
  )
  const response = await connection.sendRequest("workspace/readOffice", {
    cwd,
    path: "repeated.xlsx",
  })
  expect(response).toMatchObject({
    result: { kind: "xlsx", truncated: true },
  })
  if (!("result" in response)) throw new Error(JSON.stringify(response))
  const result = response.result as WorkspaceReadOfficeResponse
  if (result.kind !== "xlsx") throw new Error("Expected XLSX preview")
  expect(result.sheets[0]?.rows.flat().join("").length).toBeLessThanOrEqual(
    256 * 1024,
  )
})

it("rejects oversized expansion, DTDs, escaping relationships and paths outside the workspace", async () => {
  const { root, cwd, connection } = await setup()
  await writeFile(
    join(cwd, "bomb.docx"),
    await zip({
      "word/document.xml": " ".repeat(2 * 1024 * 1024 + 1),
    }),
  )
  await writeFile(
    join(cwd, "entity.docx"),
    await zip({
      "word/document.xml": `<!DOCTYPE w:document [<!ENTITY x "expanded">]><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>`,
    }),
  )
  await writeFile(
    join(cwd, "escape.xlsx"),
    await zip({
      "xl/workbook.xml": `<workbook><sheets><sheet name="evil" r:id="r1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="r1" Target="../../../escape.xml"/></Relationships>`,
    }),
  )
  await writeFile(join(root, "outside.docx"), "private")
  await symlink(join(root, "outside.docx"), join(cwd, "alias.docx"))
  for (const path of [
    "bomb.docx",
    "entity.docx",
    "escape.xlsx",
    "alias.docx",
    "../outside.docx",
  ]) {
    expect(
      await connection.sendRequest("workspace/readOffice", { cwd, path }),
    ).toMatchObject({
      error: { data: { code: "invalid_input" } },
    })
  }
  expect(
    await connection.sendRequest("workspace/readOffice", {
      cwd,
      path: "missing.pptx",
    }),
  ).toMatchObject({ error: { data: { code: "not_found" } } })
})
