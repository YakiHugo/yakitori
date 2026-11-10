import {
  Check,
  ChevronRight,
  Circle,
  CircleDot,
  ListChecks,
} from "lucide-react"
import { useEffect, useId, useState } from "react"
import type {
  SessionPlan,
  UserQuestions,
} from "../../../protocol/user-interaction.ts"
import { ApiRequestError, getAppRpcClient } from "../../lib/rpc-client.ts"
import { questionAnswerMemory } from "../../question-answer-memory.ts"
import {
  selectCurrentThreadId,
  useAppStore,
} from "../../store/app-store.ts"
import { useThreadScopeState } from "../../store/thread-scope-store.ts"
import { TranscriptDisclosureContent } from "../transcript-disclosure.tsx"
import { Button } from "../ui/button.tsx"
import { Collapsible, CollapsibleTrigger } from "../ui/collapsible.tsx"
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
  const recovered =
    sessionId === undefined
      ? undefined
      : questionAnswerMemory.read(apiBase, sessionId, toolCallId)
  const threadId = useAppStore(selectCurrentThreadId)
  const [answers, setAnswers] = useThreadScopeState(
    threadId,
    `questions:${toolCallId}:answers`,
    () => recovered?.slice() ?? request.questions.map(() => ""),
  )
  const [submitting, setSubmitting] = useState(false)
  const [pending, setPending] = useThreadScopeState(
    threadId,
    `questions:${toolCallId}:pending`,
    recovered !== undefined,
  )
  const [received, setReceived] = useState(false)
  const [error, setError] = useThreadScopeState<string | undefined>(
    threadId,
    `questions:${toolCallId}:error`,
    undefined,
  )
  const id = useId()
  const done = answered
  useEffect(() => {
    if (answered && sessionId !== undefined)
      questionAnswerMemory.acknowledge(apiBase, sessionId, toolCallId)
  }, [answered, apiBase, sessionId, toolCallId])
  return (
    <form
      aria-label="Questions from your Mate"
      className="flex flex-col gap-4 rounded-lg border p-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!sessionId || submitting || done) return
        setSubmitting(true)
        setError(undefined)
        questionAnswerMemory.reserve(apiBase, sessionId, toolCallId, answers)
        setPending(true)
        void getAppRpcClient(apiBase)
          .request("session/question/answer", {
            sessionId,
            toolCallId,
            answers,
          })
          .then(() => setReceived(true))
          .catch((reason: unknown) => {
            if (
              reason instanceof ApiRequestError &&
              reason.code !== undefined &&
              reason.code !== "internal_error"
            ) {
              questionAnswerMemory.acknowledge(apiBase, sessionId, toolCallId)
              setPending(false)
            }
            setError(
              reason instanceof Error
                ? reason.message
                : "Could not send answers.",
            )
          })
          .finally(() => setSubmitting(false))
      }}
    >
      <p className="text-body font-medium">
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
                  disabled={submitting || pending || sessionId === undefined}
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
      {!done && pending ? (
        <p role="status" className="text-detail text-muted-foreground">
          {received
            ? "Answers received; waiting for confirmation."
            : "Answer delivery is unconfirmed. Retry sends the same answers, not a new submission."}
        </p>
      ) : null}
      {!done && error ? (
        <p role="alert" className="text-detail text-destructive">
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
            {submitting
              ? "Sending…"
              : pending
                ? "Retry same answers"
                : "Send answers"}
          </Button>
        </div>
      ) : null}
    </form>
  )
}

export function PlanCell({ plan }: Readonly<{ plan: SessionPlan }>) {
  const [open, setOpen] = useState(false)
  const contentId = useId()
  const completed = plan.plan.filter(
    (step) => step.status === "completed",
  ).length
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/plan">
      <CollapsibleTrigger
        aria-controls={contentId}
        className="activity-batch-trigger text-muted-foreground"
      >
        <ListChecks aria-hidden="true" className="size-4 shrink-0" />
        <span>
          Updated plan · {completed}/{plan.plan.length} completed
        </span>
        <ChevronRight
          aria-hidden="true"
          className="size-3 shrink-0 transition-transform group-data-[state=open]/plan:rotate-90"
        />
      </CollapsibleTrigger>
      <TranscriptDisclosureContent
        id={contentId}
        open={open}
        className="space-y-3 pt-2"
      >
        {plan.explanation ? (
          <p className="text-detail text-muted-foreground">
            {plan.explanation}
          </p>
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
                className="flex items-start gap-2 text-detail"
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
      </TranscriptDisclosureContent>
    </Collapsible>
  )
}
