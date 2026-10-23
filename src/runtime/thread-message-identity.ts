// Creation, sending and result tracking must use the same durable admission key.
export function threadMessageSubmissionId(
  sourceThreadId: string,
  targetThreadId: string,
  requestId: string,
): string {
  return `thread-message:${JSON.stringify([sourceThreadId, targetThreadId, requestId])}`
}
