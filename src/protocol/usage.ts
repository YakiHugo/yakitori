export type UsageTokenTotals = Readonly<{
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheWriteInputTokens: number
}>

export type ModelUsage = UsageTokenTotals &
  Readonly<{ provider: string; model: string; turns: number }>

export type ThreadUsageSummary = Readonly<{
  generatedAt: string
  unavailableThreads?: number
  models: readonly ModelUsage[]
  modelDays: readonly (ModelUsage & Readonly<{ date: string }>)[]
  totals: UsageTokenTotals & Readonly<{ turns: number }>
  days: readonly (UsageTokenTotals &
    Readonly<{ date: string; turns: number }>)[]
  threads: readonly (UsageTokenTotals &
    Readonly<{
      threadId: string
      title: string
      updatedAt: string
      turns: number
      totalTokens: number
    }>)[]
}>
