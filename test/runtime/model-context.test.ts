import { describe, expect, it } from "vitest"
import type { ResponseItemEnvelope } from "../../src/core/rollout.ts"
import {
  retainCompactionUserMessages,
  retainRemoteCompactionMessages,
} from "../../src/runtime/model-context.ts"

describe("local compaction user history", () => {
  it("retains PDFs atomically in the remote budget while local retention remains text-only", () => {
    const document = {
      type: "document" as const,
      name: "report.pdf",
      mediaType: "application/pdf" as const,
      sizeBytes: 128_000,
      file: { rolloutId: "rollout_user", path: "attachments/report.pdf" },
    }
    const latest: ResponseItemEnvelope = {
      ...user("latest", ""),
      item: {
        role: "user",
        content: [
          document,
          { type: "text", text: "before" },
          document,
          { type: "text", text: "after" },
          document,
        ],
      },
    }
    expect(
      retainRemoteCompactionMessages([user("old", "old"), latest]),
    ).toEqual([
      {
        ...latest,
        item: {
          role: "user",
          content: [{ type: "text", text: "after" }, document],
        },
      },
    ])
    expect(retainCompactionUserMessages([latest])).toEqual([
      {
        ...latest,
        item: {
          role: "user",
          content: [{ type: "text", text: "before\nafter" }],
        },
      },
    ])
    const pdfOnly: ResponseItemEnvelope = {
      ...latest,
      item: { role: "user", content: [document] },
    }
    expect(retainRemoteCompactionMessages([pdfOnly])).toEqual([pdfOnly])
    expect(retainCompactionUserMessages([pdfOnly])).toEqual([])
  })

  it("does not mistake internal agent traffic for retained user requests", () => {
    const direct = user(
      "direct",
      '<inter_agent_message from="/root/helper">\nprogress\n</inter_agent_message>',
    )
    const completion = user(
      "completion",
      '<subagent_notification path="/root/helper" status="completed">\ndone\n</subagent_notification>',
    )
    const actual = user("actual", "Keep the public API unchanged.")

    expect(retainCompactionUserMessages([direct, completion, actual])).toEqual([
      actual,
    ])
    expect(
      retainRemoteCompactionMessages([direct, completion, actual]),
    ).toEqual([direct, actual])
  })

  it("drops oversized inter-agent progress from remote retained history", () => {
    const oversized = user(
      "oversized",
      `<inter_agent_message from="/root/helper">\n${"progress ".repeat(6_000)}\n</inter_agent_message>`,
    )
    const actual = user("actual", "Keep this request.")
    expect(retainRemoteCompactionMessages([oversized, actual])).toEqual([
      actual,
    ])
  })

  it("charges remote retained images atomically and keeps the newest boundary content", () => {
    const latest = user("latest", "")
    const images = Array.from({ length: 33 }, (_, index) => ({
      type: "image" as const,
      mediaType: "image/png" as const,
      data: `image_${index}`,
    }))
    const retained = retainRemoteCompactionMessages([
      user("old", "old request"),
      { ...latest, item: { role: "user", content: [...images] } },
    ])
    expect(retained).toEqual([
      {
        ...latest,
        item: { role: "user", content: [...images.slice(1)] },
      },
    ])
  })

  it("truncates interleaved remote content at the newest atomic boundary without regrouping", () => {
    const image = {
      type: "image" as const,
      mediaType: "image/png" as const,
      data: "pixels",
    }
    const boundary: ResponseItemEnvelope = {
      ...user("boundary", ""),
      item: {
        role: "user",
        content: [
          image,
          { type: "text", text: "d".repeat(260_000) },
          image,
          { type: "text", text: "latest correction" },
          image,
        ],
      },
    }
    const [retained] = retainRemoteCompactionMessages([boundary])
    if (retained?.item.role !== "user") throw new Error("Missing boundary")
    expect(retained.item.content.map((block) => block.type)).toEqual([
      "text",
      "image",
      "text",
      "image",
    ])
    expect(retained.item.content.slice(1)).toEqual([
      image,
      { type: "text", text: "latest correction" },
      image,
    ])
    const text = retained.item.content[0]
    expect(text?.type === "text" && text.text).toContain(
      "user message truncated",
    )
    expect(retainCompactionUserMessages([boundary])[0]?.item).toMatchObject({
      content: [
        { type: "text", text: expect.stringContaining("latest correction") },
      ],
    })
  })

  it("retains remote text corrections outside native history and rebuilt environment", () => {
    const correction = user("correction", `HEAD${"中".repeat(100_000)}TAIL`)
    const environment: ResponseItemEnvelope = {
      ...user("environment", "system-generated context"),
      item: {
        role: "user",
        content: [{ type: "text", text: "system-generated context" }],
        context: {
          type: "world_state",
          sectionId: "environment",
          revision: "1",
        },
      },
    }
    const retained = retainRemoteCompactionMessages([
      user("checkpoint", "<context_compacted>old</context_compacted>"),
      environment,
      correction,
    ])
    expect(retained.map((entry) => entry.id)).toEqual(["correction"])
    const message = retained[0]?.item
    if (message?.role !== "user") throw new Error("missing retained request")
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
    expect(text).toContain("HEAD")
    expect(text).toContain("TAIL")
    expect(text).not.toContain("\uFFFD")
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(256_000)
  })
  it("keeps user corrections and attribution independently of generated summaries", () => {
    const correction: ResponseItemEnvelope = {
      ...user("correction", "Do not change the public API."),
      submissionMetadata: { metadata: { source: "user" } },
    }
    const history = [
      user(
        "old_summary",
        "<context_compacted>old checkpoint</context_compacted>",
      ),
      user("goal", "Fix the implementation."),
      correction,
    ]
    expect(retainCompactionUserMessages(history)).toEqual([
      history[1],
      correction,
    ])
  })

  it("keeps the latest user text within the retained budget with valid Unicode", () => {
    const retained = retainCompactionUserMessages([
      user("old", "discarded oldest request"),
      user("large", `HEAD${"中".repeat(40_000)}TAIL`),
      user("latest", "latest correction"),
    ])
    expect(retained.map((item) => item.id)).toEqual(["large", "latest"])
    const text = retained
      .flatMap(({ item }) =>
        item.role === "user"
          ? item.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
          : [],
      )
      .join("")
    expect(text).toContain("HEAD")
    expect(text).toContain("TAIL")
    expect(text).toContain("latest correction")
    expect(text).not.toContain("\uFFFD")
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(80_000)
  })
})

function user(id: string, text: string): ResponseItemEnvelope {
  return {
    id,
    turnId: id,
    createdAt: "2026-09-07T00:00:00Z",
    item: { role: "user", content: [{ type: "text", text }] },
  }
}

describe.each([
  ["local", retainCompactionUserMessages],
  ["remote", retainRemoteCompactionMessages],
])("%s compaction context attribution", (_name, retain) => {
  it("excludes large injected context before spending the user retention budget", () => {
    const request: ResponseItemEnvelope = {
      ...user(
        "request",
        "Use $review to fix the parser. Keep the public API unchanged.",
      ),
      submissionMetadata: { metadata: { source: "user" } },
    }
    const correction = user(
      "correction",
      "Preserve the existing error messages too.",
    )
    const injected = (
      type: "skill_invocation" | "world_state",
    ): ResponseItemEnvelope => ({
      ...user(type, ""),
      item: {
        role: "user",
        content: [{ type: "text", text: "x".repeat(260_000) }],
        context:
          type === "skill_invocation"
            ? { type, inputId: "request" }
            : { type, sectionId: "environment", revision: "1" },
      },
    })
    expect(
      retain([
        request,
        injected("world_state"),
        correction,
        injected("skill_invocation"),
      ]),
    ).toEqual([request, correction])
  })

  it("uses source attribution rather than skill-like user text to identify injected instructions", () => {
    const request = user("request", "<skill>Explain this example.</skill>")
    const injected: ResponseItemEnvelope = {
      ...user("injected", ""),
      item: {
        role: "user",
        content: [
          { type: "text", text: "<skill>Explain this example.</skill>" },
        ],
        context: { type: "skill_invocation", inputId: "request" },
      },
    }
    expect(retain([request, injected])).toEqual([request])
  })
})
