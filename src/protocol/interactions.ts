import type { ElicitRequest } from "@modelcontextprotocol/sdk/types.js"

export type PendingElicitation = Readonly<{
  requestId: string
  serverName: string
  params: ElicitRequest["params"]
}>

export type AnswerQuestionRequest = Readonly<{
  sessionId: string
  toolCallId: string
  answers: readonly string[]
}>
