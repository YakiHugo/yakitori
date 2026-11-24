import type { WebContents } from "electron"
import { BrowserControlError } from "../protocol/desktop-browser.ts"
import type { JsonObject, JsonValue } from "../protocol/events.ts"
import { isJsonObject } from "../protocol/json.ts"
import type { BrowserProtocolCommand } from "./browser-protocol.ts"

type Request = {
  key: string
  attachment: number
  responseType?: string
  headers: JsonObject
  row: Record<string, JsonValue>
  started: number
  finished?: boolean
}

const headers = (value: unknown): JsonObject =>
  isJsonObject(value)
    ? Object.fromEntries(
        Object.entries(value).flatMap(([name, val]) =>
          [
            "accept",
            "content-type",
            "content-length",
            "cache-control",
            "last-modified",
            "etag",
            "vary",
          ].includes(name.toLowerCase()) && typeof val === "string"
            ? [[name.toLowerCase(), val.slice(0, 1024)]]
            : [],
        ),
      )
    : {}

export class BrowserTelemetry {
  readonly #console: JsonObject[] = []
  readonly #requests = new Map<string, Request>()
  #sequence = 0
  #attachment = 0
  #consoleReadThrough = 0

  constructor(contents: WebContents) {
    contents.on("console-message", (details) => {
      this.#console.push({
        level: details.level,
        message: details.message.slice(0, 1024),
        source: details.sourceId.slice(0, 512),
        line: details.lineNumber,
      })
      if (this.#console.length > 200) {
        this.#console.shift()
        this.#consoleReadThrough = Math.max(0, this.#consoleReadThrough - 1)
      }
    })
  }

  get errors(): number {
    return this.#console
      .slice(this.#consoleReadThrough)
      .filter((event) => event.level === "error").length
  }

  startNetworkAttachment(): void {
    this.#attachment++
  }

  console(offset = 0): JsonObject {
    const entries = this.#console.slice(offset, offset + 50)
    if (offset <= this.#consoleReadThrough)
      this.#consoleReadThrough = Math.max(
        this.#consoleReadThrough,
        offset + entries.length,
      )
    return {
      entries,
      ...(offset + entries.length < this.#console.length
        ? { nextOffset: offset + entries.length }
        : {}),
    }
  }

  receive(method: string, data: unknown): void {
    if (
      !method.startsWith("Network.") ||
      !isJsonObject(data) ||
      typeof data.requestId !== "string"
    )
      return
    const key = `${this.#attachment}:${data.requestId}`
    if (method === "Network.requestWillBeSent" && isJsonObject(data.request)) {
      const { url, method: verb } = data.request
      if (
        typeof url !== "string" ||
        typeof verb !== "string" ||
        !URL.canParse(url)
      )
        return
      const parsed = new URL(url)
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password
      )
        return
      this.#requests.delete(key)
      this.#requests.set(key, {
        key: data.requestId,
        attachment: this.#attachment,
        headers: headers(data.request.headers),
        started: performance.now(),
        row: {
          id: `n${++this.#sequence}`,
          method: verb.slice(0, 32),
          url: parsed.href.slice(0, 2048),
          type: String(data.type ?? "").slice(0, 40),
        },
      })
      if (this.#requests.size > 200) {
        const oldest = this.#requests.keys().next().value
        if (oldest !== undefined) this.#requests.delete(oldest)
      }
      return
    }
    const found = this.#requests.get(key)
    if (!found) return
    if (method === "Network.responseReceived" && isJsonObject(data.response)) {
      if (typeof data.response.status === "number")
        found.row.status = data.response.status
      if (typeof data.response.mimeType === "string")
        found.responseType = data.response.mimeType.slice(0, 128)
    }
    if (
      method === "Network.loadingFinished" ||
      method === "Network.loadingFailed"
    ) {
      found.finished = method === "Network.loadingFinished"
      found.row.failed = !found.finished
      found.row.durationMs = Math.max(
        0,
        Math.round(performance.now() - found.started),
      )
      if (typeof data.encodedDataLength === "number")
        found.row.encodedBytes = data.encodedDataLength
    }
  }

  async network(
    command: BrowserProtocolCommand,
    offset = 0,
    requestId?: string,
  ): Promise<JsonObject> {
    const records = [...this.#requests.values()].reverse()
    if (!requestId) {
      const entries = records.slice(offset, offset + 50).map((item) => item.row)
      return {
        entries,
        ...(offset + entries.length < records.length
          ? { nextOffset: offset + entries.length }
          : {}),
      }
    }
    const request = records.find((item) => item.row.id === requestId)
    if (!request)
      throw new BrowserControlError(
        "browser_request_stale",
        "The network request is not in this tab's retained log.",
      )
    const receipt: JsonObject = {
      ...request.row,
      requestHeaders: request.headers,
      bodyAvailable: false,
    }
    if (
      request.attachment !== this.#attachment ||
      !request.finished ||
      !(
        typeof request.row.encodedBytes === "number" &&
        request.row.encodedBytes <= 64 * 1024
      ) ||
      !/^(text\/|application\/(?:json|xml))/.test(request.responseType ?? "")
    )
      return receipt
    try {
      const payload = await command("Network.getResponseBody", {
        requestId: request.key,
      })
      if (
        isJsonObject(payload) &&
        payload.base64Encoded === false &&
        typeof payload.body === "string" &&
        Buffer.byteLength(payload.body) <= 64 * 1024
      )
        return { ...receipt, bodyAvailable: true, body: payload.body }
    } catch (cause) {
      if (
        !(cause instanceof BrowserControlError) ||
        cause.code !== "browser_protocol_error" ||
        !/No resource|No data|evicted/i.test(cause.message)
      )
        throw cause
    }
    return receipt
  }
}
