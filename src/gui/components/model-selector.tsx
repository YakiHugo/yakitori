import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Zap,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
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

function displayEffort(effort: string): string {
  return effort
    .split(/[-_]/)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ")
}

// Model capabilities own the available effort stops and speed tiers. The
// composer exposes them as one control: effort first, then model selection as a
// second-level destination, matching the Codex app's information hierarchy.
export function ModelSelector() {
  const sessionId = useAppStore((state) => state.selection.sessionId)
  const providers = useAppStore((state) => state.providers)
  const defaultProvider = useAppStore((state) => state.defaultProvider)
  const defaultModel = useAppStore((state) => state.defaultModel)
  const userPreference = useAppStore((state) => state.userPreference)
  const sessionCurrent = useAppStore((state) =>
    state.selection.sessionId === undefined
      ? state.draftModelSelection
      : state.modelSelections[state.selection.sessionId],
  )
  const setModelSelection = useAppStore((state) => state.setModelSelection)
  const [menu, setMenu] = useState<"model" | "effort">()

  useEffect(() => {
    if (menu === undefined) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(undefined)
    }
    window.addEventListener("keydown", closeOnEscape)
    return () => window.removeEventListener("keydown", closeOnEscape)
  }, [menu])

  if (providers.length === 0) return null

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
  const effortMenuAvailable =
    (efforts !== undefined && efforts.length > 0) || speeds !== undefined
  // An unpinned effort runs at the model's catalog default; show that stop
  // instead of an empty slider.
  const currentEffort = effective?.effort ?? effectiveEntry?.defaultEffort
  const peak =
    currentEffort !== undefined &&
    efforts !== undefined &&
    currentEffort === efforts[efforts.length - 1]

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

  const openFirstLevel = () => {
    setMenu((current) =>
      current === undefined
        ? effective !== undefined && effortMenuAvailable
          ? "effort"
          : "model"
        : undefined,
    )
  }

  return (
    <div className="relative flex min-w-0 items-center">
      {menu !== undefined ? (
        <div
          aria-hidden="true"
          className="fixed inset-0 z-10"
          onClick={() => setMenu(undefined)}
        />
      ) : null}

      <button
        type="button"
        aria-label="Select model and effort"
        aria-expanded={menu !== undefined}
        onClick={openFirstLevel}
        className="flex h-8 max-w-64 min-w-0 items-center gap-1.5 rounded-full bg-muted/70 px-3 text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {fast ? (
          <Zap className="size-3.5 shrink-0 fill-blue-500 text-blue-500" />
        ) : null}
        <span className="min-w-0 truncate">
          {effective === undefined
            ? "Select model"
            : displayName(providers, effective)}
        </span>
        {currentEffort === undefined ? null : (
          <span className="shrink-0 text-muted-foreground">
            {displayEffort(currentEffort)}
          </span>
        )}
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
            menu !== undefined && "rotate-180",
          )}
        />
      </button>

      {menu === "effort" && effective !== undefined ? (
        <div className="composer-control-popover absolute right-0 bottom-full z-20 mb-2 w-80 rounded-[22px] border bg-popover p-4 text-sm shadow-[0_16px_42px_-14px_color-mix(in_oklab,var(--foreground)_24%,transparent),0_3px_10px_-5px_color-mix(in_oklab,var(--foreground)_14%,transparent)]">
          <div className="grid grid-cols-[2.25rem_1fr_2.25rem] items-start">
            {speeds !== undefined ? (
              <button
                type="button"
                aria-label={fast ? "Use standard speed" : "Use fast speed"}
                title={fast ? "Fast speed" : "Standard speed"}
                onClick={toggleSpeed}
                className="grid size-8 place-items-center rounded-full transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
              <span />
            )}
            <button
              type="button"
              aria-label="Select model"
              onClick={() => setMenu("model")}
              className="mx-auto flex max-w-full flex-col items-center rounded-lg px-2 py-0.5 text-center transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span
                className={cn(
                  "flex items-center gap-0.5 text-[15px] leading-5 font-semibold",
                  peak && "effort-peak-label",
                )}
              >
                {currentEffort === undefined
                  ? "Default effort"
                  : displayEffort(currentEffort)}
                <ChevronRight className="size-3.5 shrink-0" />
              </span>
              <span className="mt-0.5 max-w-full truncate text-xs font-normal text-muted-foreground">
                {displayName(providers, effective)}
              </span>
            </button>
            <button
              type="button"
              aria-label="Reset effort to default"
              title="Reset effort to default"
              disabled={effective.effort === undefined}
              onClick={() => selectEffort(undefined)}
              className="grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-35"
            >
              <RotateCcw className="size-3.5" />
            </button>
          </div>

          {efforts !== undefined && efforts.length > 0 ? (
            <EffortSlider
              efforts={efforts}
              current={currentEffort}
              onChange={selectEffort}
            />
          ) : (
            <p className="px-2 pt-4 pb-2 text-center text-xs text-muted-foreground">
              This model has no reasoning effort levels.
            </p>
          )}
        </div>
      ) : null}

      {menu === "model" ? (
        <div className="composer-control-popover absolute right-0 bottom-full z-20 mb-2 max-h-[min(32rem,50vh)] w-72 overflow-y-auto rounded-2xl border bg-popover p-2 text-sm shadow-[0_14px_38px_-12px_color-mix(in_oklab,var(--foreground)_22%,transparent),0_3px_10px_-5px_color-mix(in_oklab,var(--foreground)_15%,transparent)]">
          <div className="flex items-center gap-1 px-1 pt-0.5 pb-1.5">
            {effortMenuAvailable ? (
              <button
                type="button"
                aria-label="Back to effort"
                onClick={() => setMenu("effort")}
                className="grid size-7 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronLeft className="size-4" />
              </button>
            ) : null}
            <span className="px-1 text-xs font-medium text-muted-foreground">
              Select model
            </span>
          </div>
          <button
            type="button"
            aria-pressed={sessionCurrent === undefined}
            onClick={() => {
              setModelSelection(sessionId, undefined)
              setMenu(undefined)
            }}
            className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">Default</span>
              <span className="block truncate text-xs text-muted-foreground">
                Recommended set of models
              </span>
            </span>
          </button>
          {[...availableProviders]
            .sort((left, right) => {
              if (left.name === defaultProvider) return -1
              if (right.name === defaultProvider) return 1
              return 0
            })
            .map((provider) =>
              provider.models.length === 0 ? null : (
                <div key={provider.name}>
                  {availableProviders.length > 1 ? (
                    <div className="px-2.5 pt-2.5 pb-0.5 text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
                      {provider.name}
                    </div>
                  ) : null}
                  {provider.models.map((model) => {
                    const selected =
                      effective?.provider === provider.name &&
                      effective.model === model.id
                    return (
                      <button
                        key={`${provider.name}/${model.id}`}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => selectModel(provider.name, model.id)}
                        className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {model.displayName ?? model.id}
                        </span>
                        {selected ? (
                          <Check
                            aria-hidden="true"
                            className="size-4 shrink-0"
                          />
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              ),
            )}
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
  const peak = index >= 0 && index === last
  const position = (stop: number) =>
    last === 0 ? "50%" : `calc(12px + (100% - 24px) * ${stop / last})`

  const pickFromPointer = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    const stop = Math.round(ratio * last)
    const effort = efforts[stop]
    if (effort !== undefined && effort !== current) onChange(effort)
  }

  return (
    <div className="px-1 pt-5 pb-1">
      <div
        ref={track}
        role="slider"
        aria-label="Reasoning effort"
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={index}
        aria-valuetext={current ?? "Default"}
        data-peak={peak}
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
        className="effort-slider-track relative h-6 w-full cursor-pointer rounded-full bg-muted outline-none ring-1 ring-foreground/5 focus-visible:ring-2 focus-visible:ring-ring"
      >
        {index >= 0 ? (
          <div
            data-peak={peak}
            className="effort-slider-fill absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ease-out"
            style={{ width: position(index) }}
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
            className="absolute top-1/2 grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full"
            style={{ left: position(stop) }}
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 rounded-full transition-colors",
                stop <= index ? "bg-white/65" : "bg-muted-foreground/45",
              )}
            />
          </button>
        ))}
        {index >= 0 ? (
          <span
            aria-hidden="true"
            className="absolute top-1/2 size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/5 bg-white shadow-[0_1px_4px_#0003] transition-[left] duration-200 ease-out"
            style={{ left: position(index) }}
          />
        ) : null}
      </div>
      <div className="flex justify-between pt-2 text-[10px] font-medium text-muted-foreground">
        <span>{displayEffort(efforts[0] ?? "")}</span>
        <span>{displayEffort(efforts[last] ?? "")}</span>
      </div>
    </div>
  )
}
