import { useCallback, useEffect, useRef, useState } from "react"
import type { SubscriptionConnection } from "../../server/subscription-connections.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import { SidebarDialog } from "./sidebar-surfaces.tsx"
import { Button } from "./ui/button.tsx"

export function ProviderSubscription({
  apiBase,
  connection,
  startLogin,
  onChange,
  onConnected,
  onClose,
  onError,
}: Readonly<{
  apiBase: string
  connection: SubscriptionConnection
  startLogin: boolean
  onChange(connections: readonly SubscriptionConnection[]): void
  onConnected(): void
  onClose(): void
  onError(message: string): void
}>) {
  const [importing, setImporting] = useState(false)
  const [text, setText] = useState("")
  const [fileName, setFileName] = useState("")
  const [pending, setPending] = useState<
    "login" | "cancel" | "import" | "file"
  >()
  const [error, setError] = useState<string>()
  const file = useRef<HTMLInputElement>(null)
  const started = useRef(false)
  const connected = useRef(false)
  const running = connection.login?.state === "running"
  const signIn = useCallback(async () => {
    setPending("login")
    setError(undefined)
    setImporting(false)
    connected.current = false
    try {
      onChange(
        await getAppRpcClient(apiBase).request("provider/subscription/login", {
          id: connection.id,
        }),
      )
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not start sign-in.",
      )
    } finally {
      setPending(undefined)
    }
  }, [apiBase, connection.id, onChange])
  useEffect(() => {
    if (!startLogin || started.current) return
    started.current = true
    void signIn()
  }, [startLogin, signIn])
  useEffect(() => {
    if (
      connection.login?.state !== "succeeded" ||
      !connection.available ||
      connected.current
    )
      return
    connected.current = true
    onConnected()
  }, [connection.login?.state, connection.available, onConnected])
  const cancel = async (close: boolean) => {
    setPending("cancel")
    setError(undefined)
    try {
      onChange(
        await getAppRpcClient(apiBase).request("provider/subscription/cancel", {
          id: connection.id,
        }),
      )
      if (close) onClose()
      else setImporting(true)
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not cancel sign-in.",
      )
    } finally {
      setPending(undefined)
    }
  }
  const importAccount = async (accountText?: string) => {
    setPending("import")
    setError(undefined)
    try {
      onChange(
        await getAppRpcClient(apiBase).request("provider/subscription/import", {
          id: connection.id,
          ...(accountText === undefined ? {} : { text: accountText }),
        }),
      )
      setText("")
      setFileName("")
      setImporting(false)
      onConnected()
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not import the account.",
      )
    } finally {
      setPending(undefined)
    }
  }
  return (
    <SidebarDialog
      title={importing ? `Import ${connection.name} account` : connection.name}
      dismissible={pending === undefined}
      onClose={() => {
        if (running)
          void getAppRpcClient(apiBase)
            .request("provider/subscription/cancel", { id: connection.id })
            .then(onChange, (cause: unknown) =>
              onError(
                cause instanceof Error
                  ? cause.message
                  : "Could not cancel sign-in.",
              ),
            )
        onClose()
      }}
    >
      {importing ? (
        <>
          <p className="provider-field-hint">
            {connection.id === "codex"
              ? "Choose Codex auth.json or a ChatGPT account export, or paste its JSON below. The account is checked with ChatGPT before it is connected."
              : "Connect the account already signed in through the Grok CLI on this computer."}
          </p>
          {connection.id === "codex" ? (
            <>
              <p className="provider-field-hint">
                Importing refreshes the account's sign-in. The tool the file
                came from may need to sign in again.
              </p>
              <div className="provider-account-file">
                <input
                  ref={file}
                  type="file"
                  accept=".json,application/json"
                  aria-label="Account file"
                  hidden
                  onChange={(event) => {
                    const selected = event.target.files?.[0]
                    if (!selected) return
                    setPending("file")
                    setError(undefined)
                    void selected
                      .text()
                      .then(
                        (value) => {
                          setText(value)
                          setFileName(selected.name)
                        },
                        (cause: unknown) =>
                          setError(
                            cause instanceof Error
                              ? cause.message
                              : "Could not read the account file.",
                          ),
                      )
                      .finally(() => setPending(undefined))
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending !== undefined}
                  onClick={() => file.current?.click()}
                >
                  Choose file…
                </Button>
                <span>{fileName}</span>
              </div>
              <textarea
                aria-label="Account JSON"
                className="provider-import-input"
                placeholder="…or paste account JSON here"
                autoComplete="off"
                spellCheck={false}
                value={text}
                disabled={pending !== undefined}
                onChange={(event) => {
                  setText(event.target.value)
                  setFileName("")
                }}
              />
            </>
          ) : null}
          {pending === "import" ? (
            <p role="status">
              {text.trim()
                ? "Checking account with ChatGPT…"
                : "Looking for the local CLI account…"}
            </p>
          ) : null}
          <div className="provider-editor-footer">
            <Button
              type="button"
              variant="ghost"
              disabled={pending !== undefined}
              onClick={() => void importAccount()}
            >
              Use local CLI account
            </Button>
            {connection.id === "codex" ? (
              <Button
                type="button"
                disabled={pending !== undefined || !text.trim()}
                onClick={() => void importAccount(text)}
              >
                Import account
              </Button>
            ) : null}
          </div>
        </>
      ) : (
        <>
          {pending === "login" || running ? (
            <p role="status">
              {pending === "login"
                ? "Starting sign-in…"
                : "Waiting for browser sign-in…"}
            </p>
          ) : connection.available ? (
            <p className="provider-message" role="status">
              Account connected. Its models are available in the conversation
              model picker.
            </p>
          ) : (
            <p className="provider-field-hint">
              Sign in with your {connection.name} subscription. Yakitori uses
              the official CLI to open the browser and complete sign-in.
            </p>
          )}
          {running && connection.login?.url ? (
            <a href={connection.login.url} target="_blank" rel="noreferrer">
              Open sign-in page ↗
            </a>
          ) : null}
          {connection.login?.state === "failed" && connection.login.message ? (
            <p role="alert">{connection.login.message}</p>
          ) : null}
          <div className="provider-editor-footer">
            <Button
              type="button"
              variant="ghost"
              disabled={pending !== undefined}
              onClick={() => {
                setError(undefined)
                if (running) void cancel(false)
                else setImporting(true)
              }}
            >
              Import existing account…
            </Button>
            {running ? (
              <Button
                type="button"
                variant="outline"
                disabled={pending !== undefined}
                onClick={() => void cancel(true)}
              >
                Cancel sign-in
              </Button>
            ) : (
              <Button
                type="button"
                disabled={pending !== undefined}
                onClick={() => void signIn()}
              >
                {connection.available ? "Sign in again" : "Sign in"}
              </Button>
            )}
          </div>
        </>
      )}
      {pending === "cancel" ? <p role="status">Cancelling sign-in…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </SidebarDialog>
  )
}
