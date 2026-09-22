import { Check, Circle, CircleDot } from "lucide-react"
import { useId, useState } from "react"
import type {
  SessionPlan,
  UserQuestions,
} from "../../../kernel/user-interaction.ts"
import { getAppRpcClient } from "../../lib/rpc-client.ts"
import { useAppStore } from "../../store/app-store.ts"
import { Button } from "../ui/button.tsx"
import { Field, FieldGroup, FieldLabel, Input } from "../ui/field.tsx"

export function UserQuestionsCell({
  request,
  toolCallId,
}: Readonly<{
  request: UserQuestions
  toolCallId: string
}>) {
  const sessionId = useAppStore((state) => state.selection.sessionId)
  const apiBase = useAppStore((state) => state.apiBase)
  const answered = useAppStore((state) =>
    state.execution.entries.some(
      (entry) => entry.kind === "user_input" && entry.questionId === toolCallId,
    ),
  )
  const [answers, setAnswers] = useState(() => request.questions.map(() => ""))
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string>()
  const id = useId()
  const done = answered || submitted
  return (
    <form
      aria-label="Questions from your Mate"
      className="flex flex-col gap-4 rounded-lg border p-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!sessionId || submitting || done) return
        setSubmitting(true)
        setError(undefined)
        void getAppRpcClient(apiBase)
          .request("session/question/answer", {
            sessionId,
            toolCallId,
            answers,
          })
          .then(() => setSubmitted(true))
          .catch((reason: unknown) => {
            setError(
              reason instanceof Error
                ? reason.message
                : "Could not send answers.",
            )
          })
          .finally(() => setSubmitting(false))
      }}
    >
      <p className="text-sm font-medium">
        {done ? "Questions answered" : "Your input"}
      </p>
      <FieldGroup>
        {request.questions.map((question, index) => (
          <Field
            // biome-ignore lint/suspicious/noArrayIndexKey: Questions are immutable within the tool call that keys this component.
            key={`${index}:${question.title}`}
            data-disabled={done || submitting}
          >
            <FieldLabel htmlFor={`${id}-${index}`}>{question.title}</FieldLabel>
            {!done ? (
              <>
                <Input
                  id={`${id}-${index}`}
                  list={question.options ? `${id}-${index}-options` : undefined}
                  value={answers[index] ?? ""}
                  onChange={(event) =>
                    setAnswers((previous) =>
                      previous.map((value, position) =>
                        position === index ? event.target.value : value,
                      ),
                    )
                  }
                  disabled={submitting || sessionId === undefined}
                  placeholder={
                    question.options
                      ? "Choose a suggestion or type your answer"
                      : "Your answer"
                  }
                  autoComplete="off"
                  required
                />
                {question.options ? (
                  <datalist id={`${id}-${index}-options`}>
                    {[...new Set(question.options)].map((option) => (
                      <option key={option} value={option} />
                    ))}
                  </datalist>
                ) : null}
              </>
            ) : null}
          </Field>
        ))}
      </FieldGroup>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!done ? (
        <div>
          <Button
            type="submit"
            size="sm"
            disabled={
              submitting ||
              !sessionId ||
              answers.some((answer) => !answer.trim())
            }
          >
            {submitting ? "Sending…" : "Send answers"}
          </Button>
        </div>
      ) : null}
    </form>
  )
}

export function PlanCell({ plan }: Readonly<{ plan: SessionPlan }>) {
  return (
    <section
      aria-label="Task plan"
      className="flex flex-col gap-3 rounded-lg border p-4"
    >
      <p className="text-sm font-medium">Task plan</p>
      {plan.explanation ? (
        <p className="text-sm text-muted-foreground">{plan.explanation}</p>
      ) : null}
      <ol className="flex flex-col gap-2">
        {plan.plan.map((step, index) => {
          const Icon =
            step.status === "completed"
              ? Check
              : step.status === "in_progress"
                ? CircleDot
                : Circle
          return (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: Each persisted plan update is an immutable tool result.
              key={`${index}:${step.step}`}
              className="flex items-start gap-2 text-sm"
            >
              <Icon
                aria-label={step.status.replaceAll("_", " ")}
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              />
              <span>{step.step}</span>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
