export type SessionCacheExpiry = Readonly<{
  provider: string
  lastTurnCompletedAt: string
  lastRequestStartedAt?: string
  ttlDescription: string
  /** Estimated from the start of the last model stream, before the network request. */
  expiresAt?: string
  /** "minimum" describes the OpenAI policy, not a guaranteed expiry timestamp. */
  status: "estimated" | "minimum" | "unknown"
}>
