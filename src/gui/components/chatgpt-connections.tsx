import { Plus } from "lucide-react"
import { useState } from "react"
import { ChatGPTUsageLink } from "./chatgpt-usage-link.tsx"
import { ProviderLogo } from "./provider-logo.tsx"
import { SidebarDialog } from "./sidebar-surfaces.tsx"
import { Button } from "./ui/button.tsx"
import { Field, FieldLabel, Input } from "./ui/field.tsx"
import { useChatGPTConnections } from "./use-chatgpt-connections.ts"

export function ChatGPTConnections({
  apiBase,
  active,
}: Readonly<{ apiBase: string; active: boolean }>) {
  const connection = useChatGPTConnections(apiBase, active)
  const { state, pending, error } = connection
  const [label, setLabel] = useState("")
  const waiting = state?.attempt?.state === "waiting"
  const blocked = pending || waiting
  const welcome = active && state?.welcomeRequired && !waiting
  const accounts = state?.accounts ?? []
  const duplicateLabel =
    !connection.reconnectingAccountId &&
    label.trim() !== "" &&
    accounts.some(
      (account) =>
        account.label === label.trim() &&
        account.id !== connection.reconnectingAccountId,
    )
  const signIn = () => {
    if (duplicateLabel) return
    void connection.signIn(
      connection.reconnectingAccountId
        ? { accountId: connection.reconnectingAccountId }
        : label.trim()
          ? { label: label.trim() }
          : {},
    )
  }

  return (
    <section className="chatgpt-connections" aria-label="ChatGPT connections">
      <div className="chatgpt-connection-heading">
        <ProviderLogo preset="openai" />
        <div className="chatgpt-connection-copy">
          <h3>Use your ChatGPT plan</h3>
          <p>
            Use your eligible ChatGPT plan or credits for AI requests in
            Yakitori. Plan usage is optional when you sign in.
          </p>
        </div>
        {accounts.length > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={blocked}
            onClick={() => {
              setLabel("")
              connection.open()
            }}
          >
            <Plus data-icon="inline-start" />
            Add account
          </Button>
        ) : null}
      </div>
      {state === undefined ? (
        <p className="provider-field-hint">
          {error
            ? "ChatGPT connections unavailable."
            : "Loading ChatGPT connections…"}
        </p>
      ) : accounts.length === 0 ? (
        <Button type="button" disabled={blocked} onClick={signIn}>
          <ProviderLogo preset="openai" />
          Continue with ChatGPT
        </Button>
      ) : (
        <ul className="chatgpt-accounts">
          {accounts.map((account) => (
            <li key={account.id} className="chatgpt-account">
              <div className="provider-connection-info">
                <strong>{account.label}</strong>
                {account.email ? <span>{account.email}</span> : null}
                <span>
                  {account.state === "connected"
                    ? "ChatGPT plan usage enabled"
                    : account.state === "identity_only"
                      ? "Signed in · plan usage not enabled"
                      : "Signed out on this device"}
                </span>
                {account.state === "identity_only" ? (
                  <p className="provider-field-hint">
                    Your identity is connected. Reconnect and allow plan usage
                    to use models from this account.
                  </p>
                ) : null}
                {account.remoteRevocation === "unconfirmed" ? (
                  <p role="status" className="chatgpt-revocation-warning">
                    Local credentials were removed. Remote revocation wasn’t
                    confirmed. Review this app’s access in ChatGPT settings.
                  </p>
                ) : null}
              </div>
              <div className="chatgpt-account-actions">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={blocked}
                  aria-label={`${account.state === "identity_only" ? "Enable plan usage for" : "Reconnect"} ${account.label}`}
                  onClick={() =>
                    void connection.signIn({ accountId: account.id })
                  }
                >
                  {account.state === "identity_only"
                    ? "Enable plan usage"
                    : "Reconnect"}
                </Button>
                {account.state !== "signed_out" ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={blocked}
                    aria-label={`Sign out ${account.label}`}
                    onClick={() => void connection.signOut(account.id)}
                  >
                    Sign out
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="chatgpt-connection-footer">
        <ChatGPTUsageLink />
        <span>Review usage, limits and app access in ChatGPT settings</span>
      </div>
      {waiting && !connection.dialog ? (
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => void connection.close()}
        >
          Cancel sign-in
        </Button>
      ) : null}
      {error && !connection.dialog && !welcome ? (
        <p role="alert">
          {error}
          {state === undefined ? (
            <>
              {" "}
              <button type="button" onClick={() => void connection.refresh()}>
                Retry
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      {welcome ? (
        <SidebarDialog
          key={error ?? "welcome"}
          title="You’re using your ChatGPT plan"
          dismissible={!pending}
          onClose={() => void connection.acknowledge()}
        >
          <p className="provider-field-hint">
            Eligible AI requests in Yakitori use your ChatGPT plan or available
            credits. You can review usage and adjust limits in ChatGPT settings.
          </p>
          {error ? <p role="alert">{error}</p> : null}
          <div className="provider-editor-footer">
            <ChatGPTUsageLink />
            <Button
              type="button"
              disabled={pending}
              onClick={() => void connection.acknowledge()}
            >
              Got it
            </Button>
          </div>
        </SidebarDialog>
      ) : connection.dialog && active ? (
        <SidebarDialog
          title="Connect ChatGPT"
          dismissImmediately
          onClose={() => void connection.close()}
        >
          {pending || waiting ? (
            <>
              <p role="status">
                {waiting
                  ? "Waiting for sign-in in your system browser…"
                  : "Starting ChatGPT sign-in…"}
              </p>
              <p className="provider-field-hint">
                Choose your account and review plan usage permission in the
                browser. You can cancel and return later.
              </p>
              <div className="provider-editor-footer">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void connection.close()}
                >
                  Cancel sign-in
                </Button>
              </div>
            </>
          ) : connection.dialog === "attempt" &&
            state?.attempt?.state === "identity_only" ? (
            <>
              <p role="status">Signed in. ChatGPT plan usage wasn’t enabled.</p>
              <p className="provider-field-hint">
                You can keep this identity connection and reconnect later to
                allow plan usage.
              </p>
              <Button type="button" onClick={() => void connection.close()}>
                Done
              </Button>
            </>
          ) : connection.dialog === "attempt" &&
            state?.attempt?.state === "succeeded" ? (
            <>
              <p role="status">
                ChatGPT connected. Choose this account in the model selector.
              </p>
              <Button type="button" onClick={() => void connection.close()}>
                Done
              </Button>
            </>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                signIn()
              }}
            >
              {state?.attempt?.state === "failed" ? (
                <p role="alert">ChatGPT sign-in did not finish. Try again.</p>
              ) : null}
              {connection.reconnectingAccountId ? (
                <p className="provider-field-hint">
                  Reconnect{" "}
                  {accounts.find(
                    (account) =>
                      account.id === connection.reconnectingAccountId,
                  )?.label ?? "this saved account"}{" "}
                  in your system browser.
                </p>
              ) : (
                <Field>
                  <FieldLabel htmlFor="chatgpt-account-label">
                    Account label
                  </FieldLabel>
                  <Input
                    id="chatgpt-account-label"
                    value={label}
                    aria-invalid={duplicateLabel}
                    aria-describedby={
                      duplicateLabel ? "chatgpt-label-error" : undefined
                    }
                    placeholder="Personal or Work"
                    autoComplete="off"
                    data-autofocus
                    maxLength={80}
                    onChange={(event) => setLabel(event.target.value)}
                  />
                </Field>
              )}
              {duplicateLabel ? (
                <p id="chatgpt-label-error" role="alert">
                  Choose a different label for this connection.
                </p>
              ) : null}
              <p className="provider-field-hint">
                Use a distinct label for each saved connection, such as Personal
                or Work. Even connections with the same email stay separate.
              </p>
              <div className="provider-editor-footer">
                <Button type="submit" disabled={duplicateLabel}>
                  <ProviderLogo preset="openai" />
                  Continue with ChatGPT
                </Button>
              </div>
            </form>
          )}
          {error ? <p role="alert">{error}</p> : null}
        </SidebarDialog>
      ) : null}
    </section>
  )
}
