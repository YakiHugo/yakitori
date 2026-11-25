import { useTranslation } from "../i18n/use-translation.ts"
import {
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
  Presentation,
} from "lucide-react"
import { useState } from "react"
import type { WorkspaceReadOfficeResponse } from "../../protocol/workspace.ts"
import "./office-preview.css"

export function OfficePreview({
  document,
}: Readonly<{ document: WorkspaceReadOfficeResponse }>) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState(0)
  if (document.kind === "docx")
    return (
      <div className="office-preview office-document">
        <article
          aria-label={t("Document preview")}
          className="office-document-page"
        >
          {document.blocks.length === 0 ? (
            <p className="office-preview-empty">
              {t("No readable document text.")}
            </p>
          ) : (
            document.blocks.map((block, index) =>
              block.kind === "paragraph" ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: document blocks are ordered positions.
                <p key={index}>{block.text || "\u00a0"}</p>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: document blocks are ordered positions.
                <div className="office-document-table-scroll" key={index}>
                  <table aria-label={t("Document table {0}", index + 1)}>
                    <tbody>
                      {block.rows.map((row, rowIndex) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: table rows are ordered positions.
                        <tr key={rowIndex}>
                          {row.map((cell, cellIndex) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: table cells are ordered positions.
                            <td key={cellIndex}>{cell}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ),
            )
          )}
        </article>
        {document.truncated ? (
          <p className="office-preview-limit">
            {t("Document preview is partial.")}
          </p>
        ) : null}
      </div>
    )

  if (document.kind === "xlsx") {
    const sheet = document.sheets[selected]
    const width = Math.max(0, ...(sheet?.rows ?? []).map((row) => row.length))
    return (
      <div className="office-preview office-workbook">
        <nav className="office-sheet-tabs" aria-label={t("Worksheets")}>
          <FileSpreadsheet size={15} aria-hidden="true" />
          {document.sheets.map((item, index) => (
            <button
              type="button"
              key={item.name}
              aria-current={index === selected ? "page" : undefined}
              onClick={() => setSelected(index)}
            >
              {item.name}
            </button>
          ))}
        </nav>
        {sheet ? (
          <div className="office-sheet-scroll">
            <table aria-label={t("{0} worksheet", sheet.name)}>
              <thead>
                <tr>
                  <th scope="col" className="office-sheet-corner">
                    #
                  </th>
                  {Array.from({ length: width }, (_, index) => (
                    <th scope="col" key={columnLabel(index)}>
                      {columnLabel(index)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sheet.rows.map((row, rowIndex) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: worksheet rows are ordered positions.
                  <tr key={rowIndex}>
                    <th scope="row">{rowIndex + 1}</th>
                    {Array.from({ length: width }, (_, index) => (
                      <td key={columnLabel(index)}>{row[index] ?? ""}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="office-preview-empty">
            {t("No worksheets to preview.")}
          </p>
        )}
        <p className="office-preview-limit">
          {t(
            "Raw cell values are shown. Dates, percentages, and formulas may look different in Excel.",
          )}
        </p>
        {document.truncated ? (
          <p className="office-preview-limit">
            {t("Worksheet preview is partial.")}
          </p>
        ) : null}
      </div>
    )
  }

  const slide = document.slides[selected]
  return (
    <div className="office-preview office-presentation">
      {slide ? (
        <>
          <div className="office-slide-controls">
            <Presentation size={15} aria-hidden="true" />
            <span>
              {t("Slide")} {selected + 1} of {document.slides.length}
            </span>
            <div>
              <button
                type="button"
                aria-label={t("Previous slide")}
                disabled={selected === 0}
                onClick={() => setSelected(selected - 1)}
              >
                <ChevronLeft size={16} />
              </button>
              <button
                type="button"
                aria-label={t("Next slide")}
                disabled={selected === document.slides.length - 1}
                onClick={() => setSelected(selected + 1)}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
          <section
            className="office-slide"
            aria-label={t("Slide {0}", slide.number)}
          >
            {slide.paragraphs.length === 0 ? (
              <p className="office-preview-empty">
                {t("No readable slide text.")}
              </p>
            ) : (
              slide.paragraphs.map((paragraph, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: slide paragraphs are ordered positions.
                <p key={index}>{paragraph}</p>
              ))
            )}
          </section>
          {slide.notes.length > 0 ? (
            <aside
              className="office-slide-notes"
              aria-label={t("Speaker notes")}
            >
              <strong>{t("Speaker notes")}</strong>
              {slide.notes.map((note, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: note paragraphs are ordered positions.
                <p key={index}>{note}</p>
              ))}
            </aside>
          ) : null}
        </>
      ) : (
        <p className="office-preview-empty">{t("No slides to preview.")}</p>
      )}
      {document.truncated ? (
        <p className="office-preview-limit">
          {t("Presentation preview is partial.")}
        </p>
      ) : null}
    </div>
  )
}

function columnLabel(index: number): string {
  let value = index + 1
  let label = ""
  while (value > 0) {
    value -= 1
    label = String.fromCharCode(65 + (value % 26)) + label
    value = Math.floor(value / 26)
  }
  return label
}
