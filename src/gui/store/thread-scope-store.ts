import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useRef,
} from "react"
import { create } from "zustand"

type ScopeEntry = { value: unknown }

type ThreadScopeStore = {
  valuesByThread: Record<string, Record<string, ScopeEntry>>
}

const useThreadScopeStore = create<ThreadScopeStore>(() => ({
  valuesByThread: {},
}))

const disposersByThread = new Map<string, Map<string, () => void>>()

export function registerThreadScopeDisposer(
  threadId: string,
  key: string,
  dispose: () => void,
): void {
  const disposers = disposersByThread.get(threadId) ?? new Map()
  disposers.set(key, dispose)
  disposersByThread.set(threadId, disposers)
}

function disposeThreadScope(threadId: string): void {
  const disposers = disposersByThread.get(threadId)
  disposersByThread.delete(threadId)
  for (const dispose of disposers?.values() ?? []) dispose()
}

export function readThreadScopeValue<T>(
  threadId: string,
  key: string,
  fallback: T,
): T {
  const entry = useThreadScopeStore.getState().valuesByThread[threadId]?.[key]
  return entry === undefined ? fallback : (entry.value as T)
}

export function writeThreadScopeValue<T>(
  threadId: string,
  key: string,
  value: T,
): void {
  useThreadScopeStore.setState((state) => {
    const scope = state.valuesByThread[threadId]
    if (scope?.[key] && Object.is(scope[key].value, value)) return state
    return {
      valuesByThread: {
        ...state.valuesByThread,
        [threadId]: { ...scope, [key]: { value } },
      },
    }
  })
}

export function removeThreadScope(threadId: string): void {
  disposeThreadScope(threadId)
  useThreadScopeStore.setState((state) => {
    if (!(threadId in state.valuesByThread)) return state
    const valuesByThread = { ...state.valuesByThread }
    delete valuesByThread[threadId]
    return { valuesByThread }
  })
}

export function clearThreadScopes(): void {
  for (const threadId of disposersByThread.keys()) disposeThreadScope(threadId)
  useThreadScopeStore.setState({ valuesByThread: {} })
}

export function useThreadScopeState<T>(
  threadId: string,
  key: string,
  initialValue: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const initial = useRef<{ value: T } | undefined>(undefined)
  if (initial.current === undefined)
    initial.current = {
      value:
        typeof initialValue === "function"
          ? (initialValue as () => T)()
          : initialValue,
    }
  const fallback = initial.current.value
  const entry = useThreadScopeStore(
    (state) => state.valuesByThread[threadId]?.[key],
  )
  const setValue = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => {
      const current = readThreadScopeValue(threadId, key, fallback)
      writeThreadScopeValue(
        threadId,
        key,
        typeof next === "function" ? (next as (current: T) => T)(current) : next,
      )
    },
    [fallback, key, threadId],
  )
  return [entry === undefined ? fallback : (entry.value as T), setValue]
}
