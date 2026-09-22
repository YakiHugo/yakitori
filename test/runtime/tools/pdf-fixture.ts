// A complete PDF with real cross-reference offsets and standard-font text,
// generated locally so extraction tests do not depend on a reference checkout.
export function pdfFixture(texts: string[]): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${texts.map((_text, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${texts.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...texts.flatMap((text, index) => {
      const escaped = text.replace(/[\\()]/g, "\\$&")
      const stream = `BT /F1 18 Tf 30 120 Td (${escaped}) Tj ET`
      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 160] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
        `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
      ]
    }),
  ]
  let pdf = "%PDF-1.4\n"
  const offsets = objects.map((body, index) => {
    const offset = Buffer.byteLength(pdf)
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
    return offset
  })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}
