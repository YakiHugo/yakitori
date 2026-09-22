import type { ElicitResult } from "@modelcontextprotocol/sdk/types.js"
import { ExternalLink } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import type { PendingElicitation } from "../../server/user-interactions.ts"
import { openUrlTarget } from "../lib/open-resource.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import { useAppStore } from "../store/app-store.ts"
import {
  type ElicitationValue,
  parseElicitationSchema,
  readElicitationValues,
} from "./elicitation-schema.ts"
import { Button } from "./ui/button.tsx"
import { Field, FieldGroup, FieldLabel, Input } from "./ui/field.tsx"

export function SessionElicitation() {
  const apiBase = useAppStore((state) => state.apiBase)
  const sessionId = useAppStore((state) => state.selectedSession?.id)
  return sessionId === undefined ? null : (
    <SessionRequests
      key={`${apiBase}:${sessionId}`}
      apiBase={apiBase}
      sessionId={sessionId}
    />
  )
}

function SessionRequests({
  apiBase,
  sessionId,
}: Readonly<{ apiBase: string; sessionId: string }>) {
  const [requests, setRequests] = useState<readonly PendingElicitation[]>([])
  const [error, setError] = useState<string>()
  // Prevent a list response already in flight from restoring an answered card.
  const answered = useRef(new Set<string>())
  useEffect(() => {
    let current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      let delay = 2_000
      try {
        const response = await getAppRpcClient(apiBase).request(
          "session/elicitation/list",
          { sessionId },
        )
        if (!current) return
        const pending = response.requests.filter(
          (request) => !answered.current.has(request.requestId),
        )
        setRequests(pending)
        setError(undefined)
        if (pending.length) delay = 1_000
      } catch (error) {
        if (current)
          setError(
            error instanceof Error
              ? error.message
              : "Could not load MCP requests.",
          )
      } finally {
        if (current) timer = setTimeout(() => void refresh(), delay)
      }
    }
    void refresh()
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [apiBase, sessionId])

  if (!requests.length && error === undefined) return null
  return (
    <section aria-label="MCP requests" className="flex flex-col gap-3">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {requests.map((request) => (
        <ElicitationCard
          key={request.requestId}
          request={request}
          apiBase={apiBase}
          sessionId={sessionId}
          onAnswered={() => {
            answered.current.add(request.requestId)
            setRequests((current) =>
              current.filter((entry) => entry.requestId !== request.requestId),
            )
          }}
        />
      ))}
    </section>
  )
}

function ElicitationCard({
  request,
  apiBase,
  sessionId,
  onAnswered,
}: Readonly<{
  request: PendingElicitation
  apiBase: string
  sessionId: string
  onAnswered: () => void
}>) {
  const id = useId()
  const { params } = request
  const [schema] = useState(() =>
    params.mode === "url"
      ? undefined
      : parseElicitationSchema(params.requestedSchema),
  )
  const [values, setValues] = useState<
    Record<string, ElicitationValue | undefined>
  >(() =>
    Object.fromEntries(
      (schema?.fields ?? []).map((field) => [field.name, field.defaultValue]),
    ),
  )
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const answer = async (result: ElicitResult) => {
    setBusy(true)
    setError(undefined)
    try {
      await getAppRpcClient(apiBase).request("session/elicitation/answer", {
        sessionId,
        requestId: request.requestId,
        result,
      })
      if (mounted.current) onAnswered()
    } catch (error) {
      if (mounted.current)
        setError(
          error instanceof Error
            ? error.message
            : "Could not send your response.",
        )
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  const validUrl =
    params.mode === "url" &&
    /^https?:\/\//i.test(params.url) &&
    URL.canParse(params.url)
  const update = (name: string, value: ElicitationValue | undefined) =>
    setValues((current) => ({ ...current, [name]: value }))

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="rounded-lg border bg-card p-4 text-card-foreground"
      aria-busy={busy}
    >
      <h3 id={`${id}-title`} className="text-sm font-medium">
        {request.serverName} needs your input
      </h3>
      <p className="mt-2 whitespace-pre-wrap text-sm">{params.message}</p>
      <form
        className="mt-4 flex flex-col gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          if (busy) return
          if (params.mode === "url") {
            if (validUrl) void answer({ action: "accept" })
          } else if (schema?.fields) {
            const result = readElicitationValues(schema.fields, values)
            setFieldErrors(result.errors)
            if (!Object.keys(result.errors).length)
              void answer({ action: "accept", content: result.content })
          }
        }}
      >
        {params.mode === "url" ? (
          validUrl ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-xs text-muted-foreground">
                Complete the request in your browser, then select Done.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={async () => {
                  setError(undefined)
                  try {
                    await openUrlTarget({ kind: "url", url: params.url })
                  } catch (error) {
                    if (mounted.current)
                      setError(
                        error instanceof Error
                          ? error.message
                          : "Could not open your browser.",
                      )
                  }
                }}
              >
                <ExternalLink data-icon="inline-start" />
                Open {new URL(params.url).hostname}
              </Button>
            </div>
          ) : (
            <p role="alert" className="text-sm text-destructive">
              This request has an unsupported URL. You can decline or cancel it.
            </p>
          )
        ) : schema?.error ? (
          <p role="alert" className="text-sm text-destructive">
            {schema.error}
          </p>
        ) : (
          <FieldGroup>
            {schema?.fields?.map((field, index) => {
              const fieldId = `${id}-${index}`
              const value = values[field.name]
              const invalid = Object.hasOwn(fieldErrors, field.name)
              const describedBy =
                [
                  field.description ? `${fieldId}-description` : "",
                  invalid ? `${fieldId}-error` : "",
                ]
                  .filter(Boolean)
                  .join(" ") || undefined
              return (
                <Field
                  key={field.name}
                  data-invalid={invalid}
                  data-disabled={busy}
                >
                  <FieldLabel htmlFor={fieldId}>
                    {field.label}
                    {field.required ? " (required)" : ""}
                  </FieldLabel>
                  {field.type === "boolean" || field.choices ? (
                    <select
                      id={fieldId}
                      className="rounded-md border bg-background p-2 text-sm"
                      multiple={field.type === "array"}
                      disabled={busy}
                      required={field.required}
                      aria-invalid={invalid}
                      aria-describedby={describedBy}
                      value={
                        field.type === "boolean"
                          ? value === undefined
                            ? ""
                            : String(value)
                          : field.type === "array"
                            ? Array.isArray(value)
                              ? value
                              : []
                            : value === undefined
                              ? ""
                              : String(
                                  field.choices?.findIndex(
                                    (choice) => choice.value === value,
                                  ),
                                )
                      }
                      onChange={(event) => {
                        if (field.type === "boolean")
                          update(
                            field.name,
                            event.target.value === ""
                              ? undefined
                              : event.target.value === "true",
                          )
                        else if (field.type === "array")
                          update(
                            field.name,
                            [...event.target.options]
                              .filter((option) => option.selected)
                              .map((option) => option.value),
                          )
                        else
                          update(
                            field.name,
                            event.target.value === ""
                              ? undefined
                              : field.choices?.[Number(event.target.value)]
                                  ?.value,
                          )
                      }}
                    >
                      {field.type === "array" ? null : (
                        <option value="">Choose…</option>
                      )}
                      {field.type === "boolean" ? (
                        <>
                          <option value="true">Yes</option>
                          <option value="false">No</option>
                        </>
                      ) : (
                        field.choices?.map((choice, index) => (
                          <option
                            key={choice.value}
                            value={
                              field.type === "array"
                                ? choice.value
                                : String(index)
                            }
                          >
                            {choice.label}
                          </option>
                        ))
                      )}
                    </select>
                  ) : (
                    <Input
                      id={fieldId}
                      type={
                        field.type === "number" || field.type === "integer"
                          ? "number"
                          : field.format === "email"
                            ? "email"
                            : field.format === "date"
                              ? "date"
                              : "text"
                      }
                      step={field.type === "integer" ? 1 : "any"}
                      min={field.minimum}
                      max={field.maximum}
                      minLength={field.minLength}
                      maxLength={field.maxLength}
                      required={field.required}
                      disabled={busy}
                      aria-invalid={invalid}
                      aria-describedby={describedBy}
                      value={typeof value === "string" ? value : ""}
                      onChange={(event) =>
                        update(field.name, event.target.value)
                      }
                    />
                  )}
                  {field.description ? (
                    <p
                      id={`${fieldId}-description`}
                      className="text-xs text-muted-foreground"
                    >
                      {field.description}
                    </p>
                  ) : null}
                  {invalid ? (
                    <p
                      id={`${fieldId}-error`}
                      role="alert"
                      className="text-xs text-destructive"
                    >
                      {fieldErrors[field.name]}
                    </p>
                  ) : null}
                </Field>
              )
            })}
          </FieldGroup>
        )}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            size="sm"
            disabled={
              busy ||
              (params.mode === "url" ? !validUrl : schema?.fields === undefined)
            }
          >
            {params.mode === "url" ? "Done" : "Submit"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void answer({ action: "decline" })}
          >
            Decline
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void answer({ action: "cancel" })}
          >
            Cancel
          </Button>
        </div>
      </form>
    </section>
  )
}
