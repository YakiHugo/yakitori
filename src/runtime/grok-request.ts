import type { ModelMessage, ModelRequest } from "./model.ts"

// Grok Build pairs its prompt with <user_query> wrapping (grok-build
// 2bdd1d6a6369, session/user_message.rs). Apply it only to the request projection;
// stored conversation text and provider-independent history remain unchanged.
export function prepareGrokRequest(request: ModelRequest): ModelRequest {
  const rebuild = request.rebuildMessagesAfterOutput
  return {
    ...request,
    messages: grokUserQueries(request.messages),
    ...(rebuild === undefined
      ? {}
      : {
          rebuildMessagesAfterOutput: async () =>
            grokUserQueries(await rebuild()),
        }),
  }
}

function grokUserQueries(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.map((message) =>
    message.role === "user" && message.context === undefined
      ? {
          ...message,
          content: [
            { type: "text", text: "<user_query>\n" },
            ...message.content,
            { type: "text", text: "\n</user_query>" },
          ],
        }
      : message,
  )
}
