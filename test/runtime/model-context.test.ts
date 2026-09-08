import { describe, expect, it } from "vitest"
import type { ResponseItemEnvelope } from "../../src/core/rollout.ts"
import {
  retainCompactionUserMessages,
  retainRemoteCompactionMessages,
} from "../../src/runtime/model-context.ts"

describe("local compaction user history", () => {
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
      { ...latest, item: { role: "user", content: [], images } },
    ])
    expect(retained).toEqual([
      {
        ...latest,
        item: { role: "user", content: [], images: images.slice(1) },
      },
    ])
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
    const text = message.content.map((block) => block.text).join("")
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
        item.role === "user" ? item.content.map((block) => block.text) : [],
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
