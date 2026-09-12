import { Check, ChevronDown, RotateCcw, Zap } from "lucide-react"
import { useRef, useState } from "react"
import type { ModelSelection } from "../../kernel/events.ts"
import type { ApiProviderSummary } from "../../server/protocol.ts"
import { cn } from "../lib/utils.ts"
import {
  normalizeKimiModelSelection,
  resolveEffectiveModel,
  useAppStore,
} from "../store/app-store.ts"

function displayName(
  providers: readonly ApiProviderSummary[],
  selection: ModelSelection,
): string {
  const entry = providers
    .find((provider) => provider.name === selection.provider)
    ?.models.find((model) => model.id === selection.model)
  return entry?.displayName ?? `${selection.provider}/${selection.model}`
}

// Codex splits the control into a model pill with a checklist popover and an
// effort pill with a discrete level slider; speed rides on the slider's bolt.
export function ModelSelector() {
  const sessionId = useAppStore((state) => state.selection.sessionId)
  const providers = useAppStore((state) => state.providers)
  const defaultProvider = useAppStore((state) => state.defaultProvider)
  const defaultModel = useAppStore((state) => state.defaultModel)
  const userPreference = useAppStore((state) => state.userPreference)
  const sessionCurrent = useAppStore((state) =>
    state.selection.sessionId === undefined
      ? undefined
      : state.modelSelections[state.selection.sessionId],
  )
  const setModelSelection = useAppStore((state) => state.setModelSelection)
  const [menu, setMenu] = useState<"model" | "effort">()

  if (sessionId === undefined || providers.length === 0) return null

  const availableProviders = providers.filter(
    (provider) => provider.availability !== "requires_login",
  )

  const effective = normalizeKimiModelSelection(
    resolveEffectiveModel({
      sessionCurrent,
      userPreference,
      defaultProvider,
      defaultModel,
      providers,
    }),
    providers,
  )
  const effectiveEntry =
    effective === undefined
      ? undefined
      : providers
          .find((provider) => provider.name === effective.provider)
          ?.models.find((model) => model.id === effective.model)
  const efforts =
    effectiveEntry?.effortStyle === "none" ? undefined : effectiveEntry?.efforts
  const speeds = effectiveEntry?.speeds
  const fast = effective?.speed === "fast"

  const update = (patch: {
    provider: string
    model: string
    effort?: string
    speed?: string
  }) => {
    setModelSelection(sessionId, {
      provider: patch.provider,
      model: patch.model,
      ...(patch.effort === undefined ? {} : { effort: patch.effort }),
      ...(patch.speed === undefined ? {} : { speed: patch.speed }),
    })
  }

  const selectModel = (provider: string, model: string) => {
    const entry = providers
      .find((candidate) => candidate.name === provider)
      ?.models.find((candidate) => candidate.id === model)
    // Keep the current effort/speed only when the newly picked model offers it.
    const keepEffort =
      effective?.effort !== undefined &&
      entry?.effortStyle !== "none" &&
      (entry?.efforts?.includes(effective.effort) ?? false)
    const keepSpeed =
      effective?.speed !== undefined &&
      (entry?.speeds?.includes(effective.speed) ?? false)
    update({
      provider,
      model,
      ...(keepEffort && effective?.effort !== undefined
        ? { effort: effective.effort }
        : {}),
      ...(keepSpeed && effective?.speed !== undefined
        ? { speed: effective.speed }
        : {}),
    })
    setMenu(undefined)
  }

  const selectEffort = (effort: string | undefined) => {
    if (effective === undefined) return
    update({
      provider: effective.provider,
      model: effective.model,
      ...(effort === undefined ? {} : { effort }),
      ...(effective.speed === undefined ? {} : { speed: effective.speed }),
    })
  }

  const toggleSpeed = () => {
    if (effective === undefined) return
    update({
      provider: effective.provider,
      model: effective.model,
      ...(effective.effort === undefined ? {} : { effort: effective.effort }),
      ...(fast ? {} : { speed: "fast" }),
    })
  }

  const effortMenuAvailable = efforts !== undefined || speeds !== undefined

  return (
    <div className="relative flex items-center gap-1">
      {menu !== undefined ? (
        <div
          aria-hidden="true"
          className="fixed inset-0 z-10"
          onClick={() => setMenu(undefined)}
        />
      ) : null}
      <button
        type="button"
        aria-label="Select model"
        aria-expanded={menu === "model"}
        onClick={() => setMenu(menu === "model" ? undefined : "model")}
        className="flex items-center gap-1 rounded-full px-2 py-1 text-xs hover:bg-accent"
      >
        {fast ? <Zap className="size-3.5 fill-blue-500 text-blue-500" /> : null}
        <span className="max-w-40 truncate">
          {effective === undefined
            ? "Select model"
            : displayName(providers, effective)}
        </span>
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </button>
      {effective !== undefined && effortMenuAvailable ? (
        <button
          type="button"
          aria-label="Select effort"
          aria-expanded={menu === "effort"}
          onClick={() => setMenu(menu === "effort" ? undefined : "effort")}
          className="flex items-center gap-1 rounded-full bg-muted/70 px-2 py-1 text-xs hover:bg-accent"
        >
          <span>
            {efforts !== undefined
              ? (effective.effort ?? "Select effort")
              : fast
                ? "Fast"
                : "Standard"}
          </span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
      ) : null}

      {menu === "model" ? (
        <div className="absolute bottom-full left-0 z-20 mb-2 max-h-[60vh] w-64 overflow-y-auto rounded-2xl border bg-popover p-2 text-sm shadow-lg">
          <div className="px-2 pt-1 pb-2 text-xs text-muted-foreground">
            Select model
          </div>
          <button
            type="button"
            onClick={() => {
              setModelSelection(sessionId, undefined)
              setMenu(undefined)
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">Default</span>
              <span className="block truncate text-xs text-muted-foreground">
                Recommended set of models
              </span>
            </span>
            {sessionCurrent === undefined ? (
              <Check className="size-4 shrink-0" />
            ) : null}
          </button>
          {[...availableProviders]
            .sort((left, right) => {
              // The configured default provider leads, like codex pinning the
              // active model's group on top.
              if (left.name === defaultProvider) return -1
              if (right.name === defaultProvider) return 1
              return 0
            })
            .map((provider) =>
              provider.models.length === 0 ? null : (
                <div key={provider.name}>
                  {availableProviders.length > 1 ? (
                    <div className="px-2 pt-2 text-xs text-muted-foreground">
                      {provider.name}
                    </div>
                  ) : null}
                  {provider.models.map((model) => (
                    <button
                      key={`${provider.name}/${model.id}`}
                      type="button"
                      onClick={() => selectModel(provider.name, model.id)}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {model.displayName ?? model.id}
                      </span>
                      {effective?.provider === provider.name &&
                      effective.model === model.id ? (
                        <Check className="size-4 shrink-0" />
                      ) : null}
                    </button>
                  ))}
                </div>
              ),
            )}
        </div>
      ) : null}

      {menu === "effort" && effective !== undefined ? (
        <div className="absolute right-0 bottom-full z-20 mb-2 w-72 rounded-2xl border bg-popover p-3 text-sm shadow-lg">
          <div className="flex items-center justify-between gap-2">
            {speeds !== undefined ? (
              <button
                type="button"
                aria-label={fast ? "Use standard speed" : "Use fast speed"}
                title={fast ? "Fast speed" : "Standard speed"}
                onClick={toggleSpeed}
                className="rounded-md p-1 hover:bg-accent"
              >
                <Zap
                  className={cn(
                    "size-4",
                    fast
                      ? "fill-blue-500 text-blue-500"
                      : "text-muted-foreground",
                  )}
                />
              </button>
            ) : (
              <span className="size-6" />
            )}
            <span className="text-xs font-medium">
              {effective.effort ?? "Default"}
            </span>
            <button
              type="button"
              aria-label="Reset effort to default"
              title="Reset effort to default"
              disabled={effective.effort === undefined}
              onClick={() => selectEffort(undefined)}
              className="rounded-md p-1 hover:bg-accent disabled:opacity-40"
            >
              <RotateCcw className="size-3.5" />
            </button>
          </div>
          <div className="pt-1 text-center text-xs text-muted-foreground">
            {displayName(providers, effective)}
          </div>
          {efforts !== undefined && efforts.length > 0 ? (
            <EffortSlider
              efforts={efforts}
              current={effective.effort}
              onChange={selectEffort}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function EffortSlider({
  efforts,
  current,
  onChange,
}: Readonly<{
  efforts: readonly string[]
  current: string | undefined
  onChange(effort: string): void
}>) {
  const track = useRef<HTMLDivElement>(null)
  const index = current === undefined ? -1 : efforts.indexOf(current)
  const last = efforts.length - 1
  const position = (stop: number) => (last === 0 ? 50 : (stop / last) * 100)

  const pickFromPointer = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    const stop = Math.round(ratio * last)
    const effort = efforts[stop]
    if (effort !== undefined && effort !== current) onChange(effort)
  }

  return (
    <div className="px-1 pt-4 pb-2">
      <div
        ref={track}
        role="slider"
        aria-label="Reasoning effort"
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={index}
        aria-valuetext={current ?? "Default"}
        tabIndex={0}
        onKeyDown={(event) => {
          const step =
            event.key === "ArrowRight" || event.key === "ArrowUp"
              ? 1
              : event.key === "ArrowLeft" || event.key === "ArrowDown"
                ? -1
                : 0
          if (step === 0) return
          event.preventDefault()
          const next = Math.min(
            last,
            Math.max(0, (index < 0 ? 0 : index) + step),
          )
          const effort = efforts[next]
          if (effort !== undefined) onChange(effort)
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          pickFromPointer(event.clientX)
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            pickFromPointer(event.clientX)
        }}
        className="relative h-5 w-full cursor-pointer rounded-full bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {index >= 0 ? (
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-blue-500"
            style={{ width: `${position(index)}%` }}
          />
        ) : null}
        {efforts.map((effort, stop) => (
          <button
            key={effort}
            type="button"
            aria-label={effort}
            aria-pressed={stop === index}
            tabIndex={-1}
            onClick={() => onChange(effort)}
            className="absolute top-1/2 grid size-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full"
            style={{ left: `${position(stop)}%` }}
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-1 rounded-full",
                stop <= index ? "bg-white/70" : "bg-muted-foreground/50",
              )}
            />
          </button>
        ))}
        {index >= 0 ? (
          <span
            aria-hidden="true"
            className="absolute top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow"
            style={{ left: `${position(index)}%` }}
          />
        ) : null}
      </div>
      <div className="flex justify-between pt-1.5 text-[10px] text-muted-foreground">
        <span>{efforts[0]}</span>
        <span>{efforts[last]}</span>
      </div>
    </div>
  )
}
