import { useTranslation } from "../../i18n/use-translation.ts"
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
import { contextSourceAttributes } from "../../conversation-context.ts"
import type { ExecutionEntry } from "../../execution-view.ts"
import { ApiRequestError, getAppRpcClient } from "../../lib/rpc-client.ts"
import { cn } from "../../lib/utils.ts"
import { questionAnswerMemory } from "../../question-answer-memory.ts"
import { selectCurrentThreadId, useAppStore } from "../../store/app-store.ts"
import { useThreadScopeState } from "../../store/thread-scope-store.ts"
import { TranscriptDisclosureContent } from "../transcript-disclosure.tsx"
import { Button } from "../ui/button.tsx"
import { Collapsible, CollapsibleTrigger } from "../ui/collapsible.tsx"
import { Field, FieldGroup, FieldLabel, Input } from "../ui/field.tsx"

export function UserQuestionsCell({
  request,
  toolCallId,
  itemId,
}: Readonly<{
  request: UserQuestions
  toolCallId: string
  itemId: string
}>) {
  const { t } = useTranslation()
  const sessionId = useAppStore((state) => state.selection.sessionId)
  const apiBase = useAppStore((state) => state.apiBase)
  const answered = useAppStore((state) =>
    state.execution.entries.some(
      (entry) => entry.kind === "user_input" && entry.questionId === toolCallId,
    ),
  )
  const open = useAppStore((state) =>
    state.execution.pendingQuestionIds.includes(toolCallId),
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
  const done = answered || !open
  const canSubmit = !answered && (open || pending)
  useEffect(() => {
    if (answered && sessionId !== undefined)
      questionAnswerMemory.acknowledge(apiBase, sessionId, toolCallId)
  }, [answered, apiBase, sessionId, toolCallId])
  return (
    <form
      {...contextSourceAttributes(
        sessionId === undefined
          ? undefined
          : {
              kind: "message",
              sessionId,
              messageId: itemId,
              label: t("Question"),
            },
      )}
      aria-label={t("Questions from your Mate")}
      className="flex flex-col gap-4 rounded-lg border p-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!sessionId || submitting || !canSubmit) return
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
              useAppStore.getState().restoreQuestionDraft(sessionId, toolCallId)
            }
            setError(
              reason instanceof Error
                ? reason.message
                : t("Could not send answers."),
            )
          })
          .finally(() => setSubmitting(false))
      }}
    >
      <p className="text-body font-medium">
        {answered
          ? t("Questions answered")
          : done
            ? request.questions.length === 1
              ? t("Question closed")
              : t("Questions closed")
            : t("Your input")}
      </p>
      <FieldGroup>
        {request.questions.map((question, index) => (
          <Field
            // biome-ignore lint/suspicious/noArrayIndexKey: Questions are immutable within the tool call that keys this component.
            key={`${index}:${question.title}`}
            data-disabled={done || submitting || pending}
          >
            <FieldLabel htmlFor={done ? undefined : `${id}-${index}`}>
              {question.title}
            </FieldLabel>
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
                      ? t("Choose a suggestion or type your answer")
                      : t("Your answer")
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
            ) : (
              <>
                {!answered && pending ? (
                  <p className="text-body">{answers[index]}</p>
                ) : null}
                {question.options ? (
                  <ul className="list-inside list-disc text-detail text-muted-foreground">
                    {[...new Set(question.options)].map((option) => (
                      <li key={option}>{option}</li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </Field>
        ))}
      </FieldGroup>
      {!answered && pending ? (
        <p role="status" className="text-detail text-muted-foreground">
          {received
            ? t("Answers received; waiting for confirmation.")
            : t(
                "Answer delivery is unconfirmed. Retry sends the same answers, not a new submission.",
              )}
        </p>
      ) : null}
      {!answered && error ? (
        <p role="alert" className="text-detail text-destructive">
          {error}
        </p>
      ) : null}
      {canSubmit ? (
        <div className="flex gap-2">
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
              ? t("Sending…")
              : pending
                ? t("Retry same answers")
                : t("Send answers")}
          </Button>
          {!done ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={submitting || pending || !sessionId}
              onClick={() =>
                useAppStore.getState().dismissQuestions(toolCallId)
              }
            >
              {t("Skip questions")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </form>
  )
}

export function CompactionCell({
  entry,
}: Readonly<{ entry: Extract<ExecutionEntry, { kind: "compaction" }> }>) {
  const { t } = useTranslation()
  return (
    <div
      className={cn(
        "flex items-center gap-2 text-caption",
        entry.status === "failed"
          ? "text-destructive"
          : "text-muted-foreground",
      )}
      title={entry.errorMessage}
    >
      <span aria-hidden="true" className="grow border-t" />
      {entry.status === "completed"
        ? t("Context compacted")
        : t("Context compaction failed")}
      <span aria-hidden="true" className="grow border-t" />
    </div>
  )
}

export function PlanCell({ plan }: Readonly<{ plan: SessionPlan }>) {
  const { t } = useTranslation()
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
          {t("Updated plan ·")} {completed}/{plan.plan.length} completed
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
