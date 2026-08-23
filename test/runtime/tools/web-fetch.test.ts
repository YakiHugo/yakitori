import { createServer, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { createDefaultTools } from "../../../src/runtime/tools/registry.ts"
import {
  createWebFetchTool,
  htmlToText,
} from "../../../src/runtime/tools/web-fetch.ts"

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    ),
  )
})

async function serve(
  handler: (input: {
    readonly url: URL
    readonly response: ServerResponse
  }) => void,
): Promise<string> {
  const server = createServer((request, response) => {
    handler({ url: new URL(request.url ?? "/", "http://localhost"), response })
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${String(port)}`
}

async function fetchUrl(
  url: string,
  options: Parameters<typeof createWebFetchTool>[0] = {},
) {
  return createWebFetchTool(options).execute(
    { url },
    { workspaceRoot: process.cwd() },
  )
}

describe("web_fetch contract", () => {
  it("is auto-allowed, read-only, and part of the default tool set", () => {
    const tool = createWebFetchTool()
    expect(tool).toMatchObject({
      name: "web_fetch",
      autoAllow: true,
      effect: "observe",
      inputSchema: {
        additionalProperties: false,
        required: ["url"],
        properties: { url: { type: "string" } },
      },
    })
    expect(createDefaultTools().map((entry) => entry.name)).toContain(
      "web_fetch",
    )
  })

  it("fetches plain text with a status line", async () => {
    const base = await serve(({ response }) => {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      response.end("hello world")
    })
    const result = await fetchUrl(`${base}/note.txt`)
    expect(result).toMatchObject({
      ok: true,
      content: "HTTP 200 OK\n\nhello world",
      output: {
        url: `${base}/note.txt`,
        status: 200,
        contentType: "text/plain; charset=utf-8",
        redirects: 0,
        truncated: false,
      },
    })
  })

  it("returns JSON content as text", async () => {
    const base = await serve(({ response }) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end('{"ok":true}')
    })
    const result = await fetchUrl(base)
    expect(result).toMatchObject({
      ok: true,
      content: 'HTTP 200 OK\n\n{"ok":true}',
    })
  })

  it("returns 404 as a normal observation with status line and body", async () => {
    const base = await serve(({ response }) => {
      response.writeHead(404, { "content-type": "text/plain" })
      response.end("nothing here")
    })
    const result = await fetchUrl(base)
    expect(result).toMatchObject({
      ok: true,
      content: "HTTP 404 Not Found\n\nnothing here",
      output: { status: 404 },
    })
  })

  it("converts HTML: skips script/style, keeps links, decodes entities", async () => {
    const base = await serve(({ response }) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(
        [
          "<html><head><title>ignored</title><style>body { color: red }</style></head>",
          '<body><h1>Tom &amp; Jerry</h1><script>alert("x")</script>',
          '<p>See <a href="https://example.com/docs">the docs</a> and ',
          '<a href="https://example.com/same">https://example.com/same</a> ',
          'and <a href="/relative">relative</a>.</p>',
          "<p>5 &lt; 6 &quot;quoted&quot; &#39;apostrophe&#39; &#65;&#x42;&nbsp;end</p>",
          "</body></html>",
        ].join(""),
      )
    })
    const result = await fetchUrl(base)
    expect(result).toMatchObject({
      ok: true,
      content: [
        "HTTP 200 OK",
        "",
        "Tom & Jerry",
        "See [the docs](https://example.com/docs) and https://example.com/same and relative.",
        `5 < 6 "quoted" 'apostrophe' AB end`,
      ].join("\n"),
    })
  })

  it("preserves whitespace inside <pre>", async () => {
    const base = await serve(({ response }) => {
      response.writeHead(200, { "content-type": "text/html" })
      response.end(
        "<body><pre>if (x) {\n    return  1\n}</pre><p>after</p></body>",
      )
    })
    const result = await fetchUrl(base)
    expect(result).toMatchObject({
      ok: true,
      content: "HTTP 200 OK\n\nif (x) {\n    return  1\n}\nafter",
    })
  })

  it("follows same-origin redirects and reports the final URL", async () => {
    const base = await serve(({ url, response }) => {
      if (url.pathname === "/start") {
        response.writeHead(302, { location: "/middle" })
        response.end()
        return
      }
      if (url.pathname === "/middle") {
        response.writeHead(301, { location: "/final" })
        response.end()
        return
      }
      response.writeHead(200, { "content-type": "text/plain" })
      response.end("arrived")
    })
    const result = await fetchUrl(`${base}/start`)
    expect(result).toMatchObject({
      ok: true,
      content: "HTTP 200 OK\n\narrived",
      output: { url: `${base}/final`, redirects: 2 },
    })
  })

  it("refuses cross-origin redirects and points at the new URL", async () => {
    const other = await serve(({ response }) => {
      response.writeHead(200, { "content-type": "text/plain" })
      response.end("secret")
    })
    const base = await serve(({ response }) => {
      response.writeHead(302, { location: `${other}/target` })
      response.end()
    })
    const result = await fetchUrl(`${base}/start`)
    expect(result).toMatchObject({ ok: false, code: "cross_origin_redirect" })
    if (result.ok) throw new Error("expected cross_origin_redirect failure")
    expect(result.message).toContain(`${other}/target`)
    expect(result.message).toContain("call web_fetch again")
  })

  it("stops after the same-origin redirect limit", async () => {
    const base = await serve(({ url, response }) => {
      const hop = Number(url.pathname.slice(1))
      response.writeHead(302, { location: `/${String(hop + 1)}` })
      response.end()
    })
    const result = await fetchUrl(`${base}/0`, { maxRedirects: 3 })
    expect(result).toMatchObject({ ok: false, code: "too_many_redirects" })
  })

  it("refuses bodies whose content-length exceeds the limit", async () => {
    const base = await serve(({ response }) => {
      response.writeHead(200, {
        "content-type": "text/plain",
        "content-length": String(6 * 1024 * 1024),
      })
      response.end()
    })
    const result = await fetchUrl(base)
    expect(result).toMatchObject({
      ok: false,
      code: "response_too_large",
      message: expect.stringContaining("6291456"),
    })
  })

  it("truncates streaming bodies that lie about or omit content-length", async () => {
    const base = await serve(({ response }) => {
      response.writeHead(200, { "content-type": "text/plain" })
      response.end("x".repeat(4_096))
    })
    const result = await fetchUrl(base, { maxBodyBytes: 1_024 })
    expect(result).toMatchObject({ ok: true, output: { truncated: true } })
    if (!result.ok) throw new Error("expected success")
    expect(result.content).toContain("HTTP 200")
    expect(result.content).toContain("x".repeat(1_024))
    expect(result.content).not.toContain("x".repeat(1_025))
    expect(result.content).toContain("exceeded 1024 bytes")
  })

  it("rejects binary content types", async () => {
    const base = await serve(({ response }) => {
      response.writeHead(200, { "content-type": "image/png" })
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    })
    const result = await fetchUrl(base)
    expect(result).toMatchObject({
      ok: false,
      code: "unsupported_content_type",
      message: expect.stringContaining("image/png"),
    })
  })

  it("truncates decoded text beyond the character limit", async () => {
    const base = await serve(({ response }) => {
      response.writeHead(200, { "content-type": "text/plain" })
      response.end("y".repeat(120_000))
    })
    const result = await fetchUrl(base)
    expect(result).toMatchObject({
      ok: true,
      output: { truncated: true, characters: 100_000 },
    })
    if (!result.ok) throw new Error("expected success")
    expect(result.content).toContain(
      "(Content truncated at 100000 of 120000 characters.)",
    )
  })

  it("decodes non-UTF-8 charsets declared in content-type", async () => {
    const base = await serve(({ response }) => {
      response.writeHead(200, { "content-type": "text/plain; charset=gbk" })
      response.end(Buffer.from([0xc4, 0xe3, 0xba, 0xc3]))
    })
    const result = await fetchUrl(base)
    expect(result).toMatchObject({ ok: true, content: "HTTP 200 OK\n\n你好" })
  })

  it("rejects non-http(s) URLs and URLs with embedded credentials", async () => {
    await expect(fetchUrl("ftp://example.com/file")).resolves.toMatchObject({
      ok: false,
      code: "invalid_url",
    })
    await expect(
      fetchUrl("https://user:pass@example.com/"),
    ).resolves.toMatchObject({
      ok: false,
      code: "invalid_url",
      message: expect.stringContaining("credentials"),
    })
    await expect(fetchUrl("not a url")).resolves.toMatchObject({
      ok: false,
      code: "invalid_url",
    })
  })

  it("times out unresponsive servers", async () => {
    const base = await serve(() => {})
    const result = await fetchUrl(base, { timeoutMs: 100 })
    expect(result).toMatchObject({ ok: false, code: "fetch_timeout" })
  })

  it("times out slow-drip response bodies, not just the initial response", async () => {
    const base = await serve(({ response }) => {
      // Headers and a first chunk arrive immediately; the body never ends.
      response.writeHead(200, { "content-type": "text/plain" })
      response.write("partial")
    })
    const result = await fetchUrl(base, { timeoutMs: 100 })
    expect(result).toMatchObject({ ok: false, code: "fetch_timeout" })
  })

  it("reports network errors for unreachable hosts", async () => {
    const result = await fetchUrl("http://127.0.0.1:1/unreachable")
    expect(result).toMatchObject({ ok: false, code: "network_error" })
  })
})

describe("htmlToText", () => {
  it("collapses blank-line runs and trims non-pre lines", () => {
    expect(htmlToText("<p>one</p><div><br></div><div><p>two</p></div>")).toBe(
      "one\ntwo",
    )
  })
})
