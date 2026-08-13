import { Check } from "lucide-react"
import { useState } from "react"
import type { ModelSelection } from "../../kernel/events.ts"
import type { ApiProviderSummary } from "../../server/protocol.ts"
import { cn } from "../lib/utils.ts"
import { resolveEffectiveModel, useAppStore } from "../store/app-store.ts"
import { Button } from "./ui/button.tsx"

const SPEED_LABELS: Readonly<Record<string, string>> = {
  fast: "快速",
  standard: "标准",
}

function displayName(
  providers: readonly ApiProviderSummary[],
  selection: ModelSelection,
): string {
  const entry = providers
    .find((provider) => provider.name === selection.provider)
    ?.models.find((model) => model.id === selection.model)
  return entry?.displayName ?? `${selection.provider}/${selection.model}`
}

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
  const [open, setOpen] = useState(false)

  if (sessionId === undefined || providers.length === 0) return null

  const effective = resolveEffectiveModel({
    sessionCurrent,
    userPreference,
    defaultProvider,
    defaultModel,
  })
  const label =
    effective === undefined
      ? "model"
      : effective.effort === undefined
        ? displayName(providers, effective)
        : `${displayName(providers, effective)} · ${effective.effort}`

  const selectModel = (
    provider: string,
    model: string,
    entry?: {
      readonly efforts?: readonly string[]
      readonly speeds?: readonly string[]
    },
  ) => {
    // Keep the current effort/speed only when the newly picked model offers it.
    const effort =
      effective?.effort !== undefined &&
      entry?.efforts?.includes(effective.effort)
        ? effective.effort
        : undefined
    const speed =
      effective?.speed !== undefined && entry?.speeds?.includes(effective.speed)
        ? effective.speed
        : undefined
    setModelSelection(sessionId, {
      provider,
      model,
      ...(effort === undefined ? {} : { effort }),
      ...(speed === undefined ? {} : { speed }),
    })
    setOpen(false)
  }

  const selectEffort = (effort: string | undefined) => {
    if (effective === undefined) return
    setModelSelection(sessionId, {
      provider: effective.provider,
      model: effective.model,
      ...(effort === undefined ? {} : { effort }),
      ...(effective.speed === undefined ? {} : { speed: effective.speed }),
    })
    setOpen(false)
  }

  const selectSpeed = (speed: string | undefined) => {
    if (effective === undefined) return
    setModelSelection(sessionId, {
      provider: effective.provider,
      model: effective.model,
      ...(effective.effort === undefined ? {} : { effort: effective.effort }),
      ...(speed === undefined ? {} : { speed }),
    })
    setOpen(false)
  }

  const effectiveEntry =
    effective === undefined
      ? undefined
      : providers
          .find((provider) => provider.name === effective.provider)
          ?.models.find((model) => model.id === effective.model)
  const effectiveEfforts = effectiveEntry?.efforts
  const effectiveSpeeds = effectiveEntry?.speeds

  return (
    <div className="relative">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label="Select model"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {label}
      </Button>
      {open ? (
        <div className="absolute bottom-full left-0 z-10 mb-1 w-64 space-y-1 rounded-md border bg-popover p-2 text-sm shadow-md">
          <div className="px-2 text-xs text-muted-foreground">模型</div>
          {[...providers]
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
                  <div className="px-2 pt-1 text-xs text-muted-foreground">
                    {provider.name}
                  </div>
                  {provider.models.map((model) => (
                    <PanelRow
                      key={`${provider.name}/${model.id}`}
                      label={model.displayName ?? model.id}
                      checked={
                        effective?.provider === provider.name &&
                        effective.model === model.id
                      }
                      onSelect={() =>
                        selectModel(provider.name, model.id, model)
                      }
                    />
                  ))}
                </div>
              ),
            )}
          {effectiveEfforts === undefined ? null : (
            <div>
              <div className="px-2 pt-1 text-xs text-muted-foreground">
                推理强度
              </div>
              <PanelRow
                label="Default"
                checked={effective?.effort === undefined}
                onSelect={() => selectEffort(undefined)}
              />
              {effectiveEfforts.map((effort) => (
                <PanelRow
                  key={effort}
                  label={effort}
                  checked={effective?.effort === effort}
                  onSelect={() => selectEffort(effort)}
                />
              ))}
            </div>
          )}
          {effectiveSpeeds === undefined ? null : (
            <div>
              <div className="px-2 pt-1 text-xs text-muted-foreground">
                速度
              </div>
              {effectiveSpeeds.map((speed) => (
                <PanelRow
                  key={speed}
                  label={SPEED_LABELS[speed] ?? speed}
                  checked={
                    speed === "standard"
                      ? effective?.speed === undefined ||
                        effective.speed === "standard"
                      : effective?.speed === speed
                  }
                  onSelect={() =>
                    selectSpeed(speed === "standard" ? undefined : speed)
                  }
                />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

function PanelRow(input: {
  readonly label: string
  readonly checked: boolean
  readonly onSelect: () => void
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-accent",
        input.checked && "bg-accent",
      )}
      onClick={input.onSelect}
    >
      <span className="min-w-0 flex-1 truncate">{input.label}</span>
      {input.checked && <Check className="size-4 shrink-0" />}
    </button>
  )
}
