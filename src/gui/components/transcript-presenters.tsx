import {
  Component,
  type ComponentType,
  createContext,
  type ReactNode,
  useContext,
  useMemo,
} from "react"
import type { ExecutionEntry } from "../execution-view.ts"
import type { ToolPresentation } from "../tool-presentation.ts"
import { transcriptPresenterRegistry } from "../transcript-presenter-registry.tsx"
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
  entryKind?: Name extends "entry" ? ExecutionEntry["kind"] : never
  matches(context: PresenterProps<Name>["context"]): boolean
  before?: ComponentType<PresenterProps<Name>>
  replace?: ComponentType<PresenterProps<Name>>
  after?: ComponentType<PresenterProps<Name>>
}>

export type TranscriptPresenterRegistry = Readonly<{
  [Name in SlotName]?: readonly Presenter<Name>[]
}>
export const TranscriptPresenters = createContext<TranscriptPresenterRegistry>(
  transcriptPresenterRegistry,
)

export function TranscriptPresenterSlot<Name extends SlotName>({
  name,
  context,
  fallback,
}: Readonly<{ name: Name; context: SlotContexts[Name]; fallback: ReactNode }>) {
  const registered: readonly Presenter<Name>[] | undefined =
    useContext(TranscriptPresenters)[name]
  const engineId = useContext(ConversationScopeContext)?.engineId
  const {
    entry,
    presentation,
    entries,
    active,
    turnId,
  }: Partial<
    SlotContexts["entry"] &
      SlotContexts["turn_activity"] &
      Pick<SlotContexts["tool_detail"], "presentation">
  > = context
  const entryKind = entry?.kind
  const presenters = useMemo(
    () =>
      registered?.filter(
        (presenter) =>
          presenter.entryKind === undefined ||
          presenter.entryKind === entryKind,
      ),
    [registered, entryKind],
  )
  const scope = useMemo(
    () =>
      ({
        ...(entry === undefined ? { entries, active, turnId } : { entry }),
        ...(presentation === undefined ? {} : { presentation }),
        ...(engineId === undefined ? {} : { engineId }),
      }) as PresenterProps<Name>["context"],
    [entry, presentation, entries, active, turnId, engineId],
  )
  if (presenters === undefined || presenters.length === 0) return fallback
  return (
    <PresenterBoundary
      fallback={fallback}
      context={scope}
      presenters={presenters}
    >
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
  const snapshot = useMemo(
    () => freezeSnapshot(structuredClone(context)),
    [context],
  )
  const matches = useMemo(
    () => presenters.filter((presenter) => presenter.matches(snapshot)),
    [presenters, snapshot],
  )
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

type PresenterBoundaryInput = Readonly<{
  context: object
  presenters: readonly unknown[]
}>
type PresenterBoundaryState = PresenterBoundaryInput &
  Readonly<{ failed: boolean }>

class PresenterBoundary extends Component<
  PresenterBoundaryInput &
    Readonly<{ fallback: ReactNode; children: ReactNode }>,
  PresenterBoundaryState
> {
  override state = {
    failed: false,
    context: this.props.context,
    presenters: this.props.presenters,
  }

  static getDerivedStateFromProps(
    props: PresenterBoundaryInput,
    state: PresenterBoundaryState,
  ) {
    return props.context === state.context &&
      props.presenters === state.presenters
      ? null
      : { failed: false, context: props.context, presenters: props.presenters }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
