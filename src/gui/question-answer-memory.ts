// Like ordinary input recovery, this outbox lives for the renderer lifetime.
// Keep answers across navigation/reconnect until a durable question reply is seen.
const pending = new Map<string, readonly string[]>()

function key(apiBase: string, sessionId: string, questionId: string): string {
  return JSON.stringify([apiBase, sessionId, questionId])
}

export const questionAnswerMemory = {
  read(
    apiBase: string,
    sessionId: string,
    questionId: string,
  ): readonly string[] | undefined {
    return pending.get(key(apiBase, sessionId, questionId))?.slice()
  },
  reserve(
    apiBase: string,
    sessionId: string,
    questionId: string,
    answers: readonly string[],
  ): void {
    pending.set(key(apiBase, sessionId, questionId), answers.slice())
  },
  acknowledge(apiBase: string, sessionId: string, questionId: string): void {
    pending.delete(key(apiBase, sessionId, questionId))
  },
  clear(): void {
    pending.clear()
  },
}
