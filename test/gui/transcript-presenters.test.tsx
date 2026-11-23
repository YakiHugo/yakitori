// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ConversationScopeContext } from "../../src/gui/components/conversation-scope.tsx"
import {
  type TranscriptPresenterRegistry,
  TranscriptPresenterSlot,
  TranscriptPresenters,
} from "../../src/gui/components/transcript-presenters.tsx"

const entry = {
  kind: "assistant" as const,
  status: "completed" as const,
  at: "2026-11-23T00:00:00Z",
  turnId: "turn",
  itemId: "answer",
  text: "Saved answer",
  source: { provider: "example", callId: "call", itemId: "answer" },
}

afterEach(cleanup)

it("uses the first matching replacement and preserves declared decoration order", () => {
  const registry: TranscriptPresenterRegistry = {
    entry: [
      {
        id: "other-engine",
        matches: ({ engineId }) => engineId === "other",
        replace: () => <span>Other engine</span>,
      },
      {
        id: "example-engine",
        matches: (context) =>
          context.engineId === "test-engine" &&
          context.entry.kind === "assistant" &&
          context.entry.source?.provider === "example",
        before: ({ context }) => {
          expect(Object.isFrozen(context.entry)).toBe(true)
          expect(context.entry).not.toBe(entry)
          return <span>Before</span>
        },
        replace: ({ fallback }) => <span>Enhanced {fallback}</span>,
        after: () => <span>After</span>,
      },
      {
        id: "later-replacement",
        matches: () => true,
        replace: () => <span>Second replacement</span>,
      },
    ],
  }
  const { container } = render(
    <ConversationScopeContext.Provider
      value={{
        sessionId: "session",
        threadId: "session",
        engineId: "test-engine",
        apiBase: "",
        workspaceRoot: undefined,
        capabilities: {
          editable: false,
          supportsContextExcerpts: false,
          historyOwnership: "observed",
        },
        interactiveQuestions: false,
      }}
    >
      <TranscriptPresenters.Provider value={registry}>
        <TranscriptPresenterSlot
          name="entry"
          context={{ entry }}
          fallback={<span>{entry.text}</span>}
        />
      </TranscriptPresenters.Provider>
    </ConversationScopeContext.Provider>,
  )
  expect(container.textContent).toBe("BeforeEnhanced Saved answerAfter")
})

it("restores the built-in entry when a matched presenter fails", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {})
  try {
    render(
      <TranscriptPresenters.Provider
        value={{
          entry: [
            {
              id: "broken",
              matches: () => true,
              replace: () => {
                throw new Error("fixture")
              },
            },
          ],
        }}
      >
        <TranscriptPresenterSlot
          name="entry"
          context={{ entry }}
          fallback={<span>{entry.text}</span>}
        />
      </TranscriptPresenters.Provider>,
    )
    expect(screen.getByText(entry.text)).toBeDefined()
  } finally {
    error.mockRestore()
  }
})
