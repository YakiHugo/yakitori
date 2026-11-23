import {
  Component,
  type ComponentType,
  createContext,
  type ReactNode,
  useContext,
} from "react"
import type { ExecutionEntry } from "../execution-view.ts"
import type { ToolPresentation } from "../tool-presentation.ts"
import { ConversationScopeContext } from "./conversation-scope.tsx"

type SlotContexts = {
  entry: Readonly<{ entry: ExecutionEntry }>
  tool_detail: Readonly<{
    entry: Extract<ExecutionEntry, { kind: "tool" }>
    presentation: ToolPresentation
  }>
  turn_activity: Readonly<{
    turnId: string
    entries: readonly ExecutionEntry[]
    active: boolean
  }>
}
type SlotName = keyof SlotContexts
type PresenterProps<Name extends SlotName> = Readonly<{
  context: SlotContexts[Name] & Readonly<{ engineId?: string }>
  fallback: ReactNode
}>
type Presenter<Name extends SlotName> = Readonly<{
  id: string
  matches(context: PresenterProps<Name>["context"]): boolean
  before?: ComponentType<PresenterProps<Name>>
  replace?: ComponentType<PresenterProps<Name>>
  after?: ComponentType<PresenterProps<Name>>
}>

export type TranscriptPresenterRegistry = Readonly<{
  [Name in SlotName]?: readonly Presenter<Name>[]
}>
export const TranscriptPresenters = createContext<TranscriptPresenterRegistry>(
  {},
)

export function TranscriptPresenterSlot<Name extends SlotName>({
  name,
  context,
  fallback,
}: Readonly<{ name: Name; context: SlotContexts[Name]; fallback: ReactNode }>) {
  const presenters: readonly Presenter<Name>[] | undefined =
    useContext(TranscriptPresenters)[name]
  const engineId = useContext(ConversationScopeContext)?.engineId
  if (presenters === undefined || presenters.length === 0) return fallback
  const scope: PresenterProps<Name>["context"] = Object.assign(
    {},
    context,
    engineId === undefined ? {} : { engineId },
  )
  return (
    <PresenterBoundary fallback={fallback}>
      <Presenters presenters={presenters} context={scope} fallback={fallback} />
    </PresenterBoundary>
  )
}

function Presenters<Name extends SlotName>({
  context,
  fallback,
  presenters,
}: PresenterProps<Name> &
  Readonly<{ presenters: readonly Presenter<Name>[] }>) {
  const snapshot = freezeSnapshot(structuredClone(context))
  const matches = presenters.filter((presenter) => presenter.matches(snapshot))
  const Replace = matches.find(
    (presenter) => presenter.replace !== undefined,
  )?.replace
  return (
    <>
      {matches.map(({ id, before: Before }) =>
        Before === undefined ? null : (
          <Before key={id} context={snapshot} fallback={fallback} />
        ),
      )}
      {Replace === undefined ? (
        fallback
      ) : (
        <Replace context={snapshot} fallback={fallback} />
      )}
      {matches.map(({ id, after: After }) =>
        After === undefined ? null : (
          <After key={id} context={snapshot} fallback={fallback} />
        ),
      )}
    </>
  )
}

function freezeSnapshot<Value extends object>(value: Value): Value {
  Object.freeze(value)
  for (const child of Object.values(value))
    if (child !== null && typeof child === "object" && !Object.isFrozen(child))
      freezeSnapshot(child)
  return value
}

class PresenterBoundary extends Component<
  Readonly<{ fallback: ReactNode; children: ReactNode }>,
  Readonly<{ failed: boolean }>
> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
