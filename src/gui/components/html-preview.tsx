import "./html-preview.css"

export type HtmlPreviewProps = Readonly<{
  content: string
  truncated: boolean
}>

// The srcDoc inherits the app's URL as its base. Apply this before untrusted
// markup so relative URLs cannot load app resources or external assets.
const previewCsp =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

export function HtmlPreview({ content, truncated }: HtmlPreviewProps) {
  // An iframe sandbox still allows its own document to navigate. Parsing in a
  // detached template keeps resources inert while removing automatic refresh
  // navigation; ordinary links remain available for deliberate clicks.
  const template = document.createElement("template")
  template.innerHTML = content
  for (const meta of template.content.querySelectorAll("meta[http-equiv]")) {
    if (meta.getAttribute("http-equiv")?.trim().toLowerCase() === "refresh")
      meta.remove()
  }
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${previewCsp}"></head><body>${template.innerHTML}</body></html>`

  return (
    <div className="html-preview">
      {truncated ? (
        <p className="html-preview-notice" role="status">
          Preview is incomplete. Missing markup may affect the layout.
        </p>
      ) : null}
      <iframe
        className="html-preview-frame"
        title="HTML file preview"
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
      />
      <p className="html-preview-limits">
        Scripts and external resources are blocked. Links may navigate inside
        the preview.
      </p>
    </div>
  )
}
