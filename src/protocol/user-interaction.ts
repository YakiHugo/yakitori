export type UserQuestion = Readonly<{
  title: string
  options?: readonly string[]
}>

export type UserQuestions = Readonly<{
  kind: "user_questions"
  questions: readonly UserQuestion[]
}>

export type SessionPlan = Readonly<{
  kind: "plan"
  explanation?: string
  plan: readonly Readonly<{
    step: string
    status: "pending" | "in_progress" | "completed"
  }>[]
}>

export function parseUserQuestions(value: unknown): UserQuestions | undefined {
  if (!isRecord(value) || !Array.isArray(value.questions)) return undefined
  if (value.questions.length === 0) return undefined
  const questions: UserQuestion[] = []
  for (const question of value.questions) {
    if (!isRecord(question) || !nonempty(question.title)) return undefined
    if (
      question.options !== undefined &&
      (!Array.isArray(question.options) ||
        question.options.length === 0 ||
        !question.options.every(nonempty))
    )
      return undefined
    questions.push({
      title: question.title,
      ...(question.options === undefined ? {} : { options: question.options }),
    })
  }
  return { kind: "user_questions", questions }
}

export function parseSessionPlan(value: unknown): SessionPlan | undefined {
  if (!isRecord(value) || !Array.isArray(value.plan)) return undefined
  if (value.explanation !== undefined && typeof value.explanation !== "string")
    return undefined
  const plan: SessionPlan["plan"][number][] = []
  for (const item of value.plan) {
    if (
      !isRecord(item) ||
      !nonempty(item.step) ||
      (item.status !== "pending" &&
        item.status !== "in_progress" &&
        item.status !== "completed")
    )
      return undefined
    plan.push({ step: item.step, status: item.status })
  }
  if (plan.filter((item) => item.status === "in_progress").length > 1)
    return undefined
  return {
    kind: "plan",
    plan,
    ...(value.explanation === undefined
      ? {}
      : { explanation: value.explanation }),
  }
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
