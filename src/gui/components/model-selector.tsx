import { Check, ChevronDown, ChevronLeft, Zap } from "lucide-react"
import {
  type CSSProperties,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import type {
  ApiProviderModel,
  ApiProviderSummary,
} from "../../protocol/application.ts"
import type { ModelSelection } from "../../protocol/events.ts"
import { cn } from "../lib/utils.ts"
import {
  normalizeKimiModelSelection,
  resolveEffectiveModel,
  useAppStore,
} from "../store/app-store.ts"
import { ChatGPTUsageLink } from "./chatgpt-usage-link.tsx"

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

function hasEffortControls(model: ApiProviderModel | undefined): boolean {
  return (
    (model?.effortStyle !== "none" && (model?.efforts?.length ?? 0) > 0) ||
    model?.speeds !== undefined
  )
}

// Model capabilities own the available effort stops and speed tiers. The
// composer exposes them as one control: effort first, then model selection as a
// second-level destination, matching the Codex app's information hierarchy.
export function ModelSelector({
  selection,
  onChange,
}: Readonly<{
  selection?: ModelSelection | undefined
  onChange?: (selection: ModelSelection | undefined) => void
}> = {}) {
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
  const modelPickerRevision = useAppStore((state) => state.modelPickerRevision)
  const current = onChange === undefined ? sessionCurrent : selection
  const changeSelection = (value: ModelSelection | undefined) => {
    if (onChange) onChange(value)
    else setModelSelection(sessionId, value)
  }
  const [menu, setMenu] = useState<"model" | "effort">()
  const lastPickerRevision = useRef(modelPickerRevision)
  const previousMenu = useRef(menu)
  const selectorRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const previous = previousMenu.current
    previousMenu.current = menu
    if (previous === undefined || menu === undefined || previous === menu)
      return
    const panel = selectorRef.current
    if (menu === "effort") {
      const target =
        panel?.querySelector<HTMLElement>('[role="slider"]') ??
        panel?.querySelector<HTMLElement>(
          '[title="Fast speed"], [title="Standard speed"]',
        )
      target?.focus()
    } else {
      const target =
        panel?.querySelector<HTMLElement>('[aria-label="Back to effort"]') ??
        panel?.querySelector<HTMLElement>("[aria-pressed]")
      target?.focus()
    }
  }, [menu])

  useLayoutEffect(() => {
    if (menu === undefined) return
    const popover = popoverRef.current
    const content = popover?.firstElementChild
    const selector = selectorRef.current
    if (!popover || !(content instanceof HTMLElement) || !selector) return
    const measure = () => {
      popover.style.height = `${content.offsetHeight + popover.clientTop * 2}px`
      const anchor = selector.getBoundingClientRect()
      const center = anchor.left + anchor.width / 2
      const halfWidth = popover.offsetWidth / 2
      const visibleCenter = Math.max(
        16 + halfWidth,
        Math.min(center, window.innerWidth - 16 - halfWidth),
      )
      popover.style.left = `calc(50% + ${visibleCenter - center}px)`
    }
    measure()
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure)
    observer?.observe(content)
    observer?.observe(selector)
    window.addEventListener("resize", measure)
    window.addEventListener("scroll", measure, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", measure)
      window.removeEventListener("scroll", measure, true)
    }
  }, [menu])

  useEffect(() => {
    if (lastPickerRevision.current === modelPickerRevision) return
    lastPickerRevision.current = modelPickerRevision
    if (onChange === undefined) setMenu("model")
  }, [modelPickerRevision, onChange])

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
      sessionCurrent: current,
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
  const effortMenuAvailable = hasEffortControls(effectiveEntry)
  // An unpinned effort runs at the model's catalog default; show that stop
  // instead of an empty slider.
  const currentEffort =
    effective?.effort ??
    (effectiveEntry?.defaultEffort !== undefined &&
    efforts?.includes(effectiveEntry.defaultEffort)
      ? effectiveEntry.defaultEffort
      : undefined)
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
    changeSelection({
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
    setMenu(hasEffortControls(entry) ? "effort" : undefined)
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
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <div ref={selectorRef} className="relative flex min-w-0 items-center">
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
          className={cn(
            "h-8 max-w-64 min-w-0 items-center gap-1.5 rounded-full bg-muted/70 px-3 text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            menu === undefined
              ? "flex"
              : "grid w-40 grid-cols-[0.875rem_minmax(0,1fr)_0.875rem] text-center",
          )}
        >
          {menu !== undefined ? (
            <>
              <span aria-hidden="true" />
              <span className="min-w-0 truncate text-muted-foreground">
                {menu === "effort" ? "Select effort" : "Select model"}
              </span>
            </>
          ) : (
            <>
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
            </>
          )}
          <ChevronDown
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
              menu !== undefined && "rotate-180",
            )}
          />
        </button>

        {menu !== undefined ? (
          <div
            ref={popoverRef}
            data-model-picker=""
            className="composer-control-popover absolute bottom-full left-1/2 z-20 mb-2 overflow-hidden rounded-[20px] border bg-popover text-sm shadow-[0_14px_38px_-12px_color-mix(in_oklab,var(--foreground)_22%,transparent),0_3px_10px_-5px_color-mix(in_oklab,var(--foreground)_15%,transparent)]"
          >
            {menu === "effort" && effective !== undefined ? (
              <div className="p-3.5">
                <div className="grid grid-cols-[2.25rem_1fr_2.25rem] items-start">
                  {speeds !== undefined ? (
                    <button
                      type="button"
                      aria-label={
                        fast ? "Use standard speed" : "Use fast speed"
                      }
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
                        "text-[14px] leading-5 font-semibold text-blue-600 dark:text-blue-400",
                        peak && "effort-peak-label",
                      )}
                    >
                      {currentEffort === undefined
                        ? "Automatic"
                        : displayEffort(currentEffort)}
                    </span>
                    <span className="mt-0.5 block max-w-full truncate text-center text-[13px] font-normal text-muted-foreground">
                      {displayName(providers, effective)}
                    </span>
                  </button>
                  <span />
                </div>

                {efforts !== undefined && efforts.length > 0 ? (
                  <EffortSlider
                    efforts={efforts}
                    current={currentEffort}
                    fast={fast}
                    onChange={selectEffort}
                  />
                ) : (
                  <p className="px-2 pt-4 pb-2 text-center text-xs text-muted-foreground">
                    This model has no reasoning effort levels.
                  </p>
                )}
              </div>
            ) : (
              <div className="max-h-[min(27rem,50vh)] overflow-y-auto p-2">
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
                  aria-pressed={current === undefined}
                  onClick={() => {
                    changeSelection(undefined)
                    const defaultSelection = normalizeKimiModelSelection(
                      resolveEffectiveModel({
                        sessionCurrent: undefined,
                        userPreference,
                        defaultProvider,
                        defaultModel,
                        providers,
                      }),
                      providers,
                    )
                    const entry = providers
                      .find(
                        (provider) =>
                          provider.name === defaultSelection?.provider,
                      )
                      ?.models.find(
                        (model) => model.id === defaultSelection?.model,
                      )
                    setMenu(hasEffortControls(entry) ? "effort" : undefined)
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
                    provider.models.length === 0 &&
                    !provider.catalogError ? null : (
                      <div key={provider.name}>
                        {availableProviders.length > 1 ||
                        provider.catalogError ? (
                          <div className="px-2.5 pt-2.5 pb-0.5 text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
                            {provider.displayName ?? provider.name}
                          </div>
                        ) : null}
                        {provider.catalogError ? (
                          <div className="px-2.5 py-2 text-xs text-muted-foreground">
                            <p role="status">{provider.catalogError}</p>
                            <button
                              type="button"
                              className="mt-1 underline"
                              onClick={() => {
                                setMenu(undefined)
                                useAppStore.getState().openSettings("providers")
                              }}
                            >
                              Manage connection
                            </button>
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
                              onClick={() =>
                                selectModel(provider.name, model.id)
                              }
                              className="flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
            )}
          </div>
        ) : null}
      </div>
      {effective?.provider.startsWith("chatgpt-") ? (
        <div className="flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground">
          {effectiveEntry ? (
            <span>Using ChatGPT plan</span>
          ) : (
            <>
              <span>ChatGPT connection needs attention</span>
              <button
                type="button"
                className="underline"
                onClick={() => useAppStore.getState().openSettings("providers")}
              >
                Manage connection
              </button>
            </>
          )}
          <ChatGPTUsageLink />
        </div>
      ) : null}
    </div>
  )
}

const particleSeeds = Array.from({ length: 16 }, (_, index) => ({
  id: `effort-particle-${index}`,
  index,
}))

function EffortSlider({
  efforts,
  current,
  fast,
  onChange,
}: Readonly<{
  efforts: readonly string[]
  current: string | undefined
  fast: boolean
  onChange(effort: string): void
}>) {
  const track = useRef<HTMLDivElement>(null)
  const index = current === undefined ? -1 : efforts.indexOf(current)
  const last = efforts.length - 1
  const peak = index >= 0 && index === last
  const particleCount = Math.round((16 * (index + 1)) / efforts.length)
  const position = (stop: number) =>
    last === 0 ? "50%" : `calc(14px + (100% - 28px) * ${stop / last})`

  const pickFromPointer = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    const stop = Math.round(ratio * last)
    const effort = efforts[stop]
    if (effort !== undefined && effort !== current) onChange(effort)
  }

  return (
    <div className="px-1 pt-4 pb-0.5">
      <div
        ref={track}
        role="slider"
        aria-label="Reasoning effort"
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={index < 0 ? undefined : index}
        aria-valuetext={current ?? "Automatic (provider default)"}
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
            style={{
              width: peak ? "100%" : `calc(${position(index)} + 14px)`,
            }}
          >
            {fast || peak
              ? particleSeeds
                  .slice(0, particleCount)
                  .map(({ id, index: particle }) => {
                    const size =
                      particle % 5 === 0 ? 3 : particle % 3 === 0 ? 2.5 : 2
                    const duration =
                      (3.2 + ((particle * 7) % 6) * 0.35) * (peak ? 0.85 : 1)
                    return (
                      <span
                        key={id}
                        aria-hidden="true"
                        className="effort-slider-particle"
                        style={
                          {
                            left: `${4 + ((particle + 0.5 + (((particle * 7) % 5) - 2) * 0.1) / particleCount) * 87}%`,
                            top: `${4 + ((particle * 11) % 15)}px`,
                            width: size,
                            height: size,
                            animationDuration: `${duration}s`,
                            animationDelay: `-${(particle * 1.27) % duration}s`,
                            "--particle-x": `${((particle * 13) % 15) - 7}px`,
                            "--particle-y": `${((particle * 7) % 9) - 4}px`,
                          } as CSSProperties
                        }
                      />
                    )
                  })
              : null}
          </div>
        ) : null}
        {efforts.map((effort, stop) => (
          <button
            key={effort}
            type="button"
            aria-label={effort}
            aria-pressed={stop === index}
            tabIndex={-1}
            onClick={() => onChange(effort)}
            className="absolute top-1/2 grid size-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full"
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
            className="absolute top-1/2 size-7 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/5 bg-white shadow-[0_1px_4px_#0003] transition-[left] duration-200 ease-out"
            style={{ left: position(index) }}
          />
        ) : null}
      </div>
    </div>
  )
}
