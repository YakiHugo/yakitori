import type { ResolvedModel } from "../runtime/model-catalog.ts"
import type {
  ApiProviderModel,
  ApiProviderSummary,
} from "../protocol/application.ts"
import type { ModelSelection } from "../protocol/events.ts"
import type {
  ModelRoutePreview,
  ModelRouteRejection,
  ModelRouteRequirements,
} from "../protocol/model-routing.ts"
import type { ConfiguredModel } from "../protocol/providers.ts"
import { ModelNotConfiguredError } from "../runtime/configured-models-manager.ts"
import { NonChatModelError } from "../runtime/model-kind.ts"
import type { ProviderRegistry } from "../runtime/provider-registry.ts"

export type AccountModelSource = Readonly<{
  accountId: string
  namespace: string
  serviceName: string
  summary: ApiProviderSummary
  identities?: Readonly<
    Record<string, NonNullable<ConfiguredModel["identity"]>>
  >
}>

type Binding = Readonly<{
  accountId: string
  model: string
}>

export class ModelRouteError extends Error {
  readonly rejections: readonly ModelRouteRejection[]
  constructor(
    message: string,
    rejections: readonly ModelRouteRejection[] = [],
  ) {
    super(message)
    this.rejections = rejections
  }
}

// The directory groups only explicit model identities. Account-local model IDs
// stay on the binding; neither display names nor credential values are identities.
export function createModelRouter(input: {
  registry: ProviderRegistry
  readAccounts(): Promise<readonly AccountModelSource[]>
}) {
  let generation = 0
  let latestRefresh: Promise<void> | undefined
  let directory: readonly ApiProviderSummary[] = []
  let accounts: readonly ApiProviderSummary[] = []
  let bindings = new Map<string, readonly Binding[]>()
  const namespaces: string[] = []
  const key = (selection: Pick<ModelSelection, "provider" | "model">) =>
    JSON.stringify([selection.provider, selection.model])

  async function refreshDirectory() {
    const version = ++generation
    const sources = await input.readAccounts()
    if (version !== generation) return
    const groups = new Map<
      string,
      {
        name: string
        displayName: string
        models: Map<string, ApiProviderModel[]>
        available: boolean
        errors: string[]
      }
    >()
    const nextBindings = new Map<string, Binding[]>()
    for (const account of sources) {
      const available =
        account.summary.availability !== "requires_login" &&
        input.registry.providers.includes(account.accountId)
      if (!groups.has(account.namespace))
        groups.set(account.namespace, {
          name: account.namespace,
          displayName: account.serviceName,
          models: new Map(),
          available,
          errors: account.summary.catalogError
            ? [account.summary.catalogError]
            : [],
        })
      for (const model of account.summary.models) {
        const identity = account.identities?.[model.id] ?? {
          namespace: account.namespace,
          model: model.id,
        }
        let group = groups.get(identity.namespace)
        if (!group) {
          group = {
            name: identity.namespace,
            displayName: account.serviceName,
            models: new Map(),
            available: false,
            errors: [],
          }
          groups.set(identity.namespace, group)
        }
        group.available ||= available
        if (account.summary.catalogError)
          group.errors.push(account.summary.catalogError)
        if (!available) continue
        // Visibility controls the picker, not an already-selected chat model.
        const rows = group.models.get(identity.model) ?? []
        rows.push({ ...model, id: identity.model })
        group.models.set(identity.model, rows)
        const identityKey = key({
          provider: identity.namespace,
          model: identity.model,
        })
        const candidates = nextBindings.get(identityKey) ?? []
        candidates.push({
          accountId: account.accountId,
          model: model.id,
        })
        nextBindings.set(identityKey, candidates)
      }
    }
    directory = [...groups.values()].map((group) => ({
      name: group.name,
      displayName: group.displayName,
      availability: group.available ? "available" : "requires_login",
      models: [...group.models.entries()].map(([id, rows]) => {
        const first = rows[0]
        if (!first) throw new Error("Model group has no source.")
        const efforts = [
          ...new Set(
            rows.flatMap((row) =>
              row.effortStyle === "none" ? [] : (row.efforts ?? []),
            ),
          ),
        ]
        const speeds = [...new Set(rows.flatMap((row) => row.speeds ?? []))]
        return {
          id,
          ...(rows.every((row) => row.visible === false)
            ? { visible: false }
            : {}),
          ...(first.displayName === undefined
            ? {}
            : { displayName: first.displayName }),
          instructionProfileId: rows.every(
            (row) => row.instructionProfileId === first.instructionProfileId,
          )
            ? first.instructionProfileId
            : "default",
          inputModalities: [
            ...new Set(
              rows.flatMap((row) => row.inputModalities ?? ["text" as const]),
            ),
          ],
          imageDetailModes: [
            ...new Set(rows.flatMap((row) => row.imageDetailModes ?? [])),
          ],
          effortStyle: efforts.length ? "levels" : "none",
          ...(efforts.length ? { efforts } : {}),
          ...(first.defaultEffort &&
          rows.every((row) => row.defaultEffort === first.defaultEffort) &&
          efforts.includes(first.defaultEffort)
            ? { defaultEffort: first.defaultEffort }
            : {}),
          ...(speeds.length ? { speeds } : {}),
        }
      }),
      ...(group.errors.length && !group.models.size
        ? { catalogError: group.errors[0] }
        : {}),
    }))
    bindings = nextBindings
    accounts = sources.map((source) => source.summary)
    namespaces.splice(0, namespaces.length, ...groups.keys())
  }

  function evaluate(
    selection: ModelSelection,
    requirements: ModelRouteRequirements &
      Readonly<{ preferredAccount?: string }> = {},
  ): Readonly<{
    candidate: Binding
    target: ModelSelection
    model?: ResolvedModel
    rejection?: ModelRouteRejection
  }>[] {
    const candidates = [...(bindings.get(key(selection)) ?? [])].sort(
      (a, b) =>
        Number(b.accountId === requirements.preferredAccount) -
        Number(a.accountId === requirements.preferredAccount),
    )
    return candidates.map((candidate) => {
      const target = {
        ...selection,
        provider: candidate.accountId,
        model: candidate.model,
      }
      const reject = (code: ModelRouteRejection["code"], message: string) => ({
        candidate,
        target,
        rejection: {
          accountId: candidate.accountId,
          model: candidate.model,
          code,
          message,
        },
      })
      if (!input.registry.providers.includes(candidate.accountId))
        return reject(
          "model_unavailable",
          "The account is no longer connected.",
        )
      const models = input.registry.models(candidate.accountId)
      let model: ReturnType<typeof models.resolve>
      try {
        model = models.resolve(target)
      } catch (error) {
        if (
          error instanceof ModelNotConfiguredError ||
          error instanceof NonChatModelError
        )
          return reject(
            "model_unavailable",
            "The account does not provide this chat model.",
          )
        throw error
      }
      const modality = requirements.inputModalities?.find(
        (modality) => !model.inputModalities.includes(modality),
      )
      if (modality)
        return reject(
          "unsupported_modality",
          `This account does not support ${modality} input.`,
        )
      if (
        requirements.imageDetail &&
        !model.imageDetailModes.includes(requirements.imageDetail)
      )
        return reject(
          "unsupported_image_detail",
          `This account does not support ${requirements.imageDetail} image detail.`,
        )
      if (
        selection.effort !== undefined &&
        !model.efforts?.includes(selection.effort)
      )
        return reject(
          "unsupported_effort",
          `This account does not support effort ${selection.effort}.`,
        )
      if (
        selection.speed !== undefined &&
        !model.speeds?.includes(selection.speed)
      )
        return reject(
          "unsupported_speed",
          `This account does not support speed ${selection.speed}.`,
        )
      if (requirements.contextWindowTokens !== undefined) {
        const capacity = models.capacity(target)
        if (
          capacity === undefined ||
          capacity.maxContextWindowTokens < requirements.contextWindowTokens
        )
          return reject(
            "budget_exceeded",
            "This account cannot provide the requested context window.",
          )
      }
      models.validate(target)
      return { candidate, target, model }
    })
  }

  function preview(
    selection: ModelSelection,
    requirements: ModelRouteRequirements &
      Readonly<{ preferredAccount?: string }> = {},
  ): ModelRoutePreview {
    const results = evaluate(selection, requirements)
    const accepted = results.filter((result) => result.model !== undefined)
    const selected = accepted[0]
    const { effort: _effort, ...withoutEffort } = selection
    const { speed: _speed, ...withoutSpeed } = selection
    const effortModels = evaluate(withoutEffort, requirements).flatMap(
      (result) => (result.model ? [result.model] : []),
    )
    const speedCandidates = evaluate(withoutSpeed, requirements).flatMap(
      (result) => (result.model ? [result.model] : []),
    )
    return {
      available: selected !== undefined,
      ...(selected === undefined ? {} : { target: selected.target }),
      ...(selected?.model?.defaultEffort === undefined
        ? {}
        : { defaultEffort: selected.model.defaultEffort }),
      efforts: [
        ...new Set(effortModels.flatMap((model) => model.efforts ?? [])),
      ],
      speeds: [
        ...new Set(speedCandidates.flatMap((model) => model.speeds ?? [])),
      ],
      inputModalities: [
        ...new Set(
          accepted.flatMap((result) => result.model?.inputModalities ?? []),
        ),
      ],
      imageDetailModes: [
        ...new Set(
          accepted.flatMap((result) => result.model?.imageDetailModes ?? []),
        ),
      ],
      rejections: results.flatMap((result) =>
        result.rejection ? [result.rejection] : [],
      ),
    }
  }

  function route(
    selection: ModelSelection,
    requirements: ModelRouteRequirements &
      Readonly<{ preferredAccount?: string }> = {},
  ): ModelSelection {
    const results = evaluate(selection, requirements)
    const selected = results.find((result) => result.model !== undefined)
    if (selected) return selected.target
    if (!results.length)
      throw new ModelRouteError(
        `No connected account provides ${selection.provider}/${selection.model}.`,
      )
    const rejections = results.flatMap((result) =>
      result.rejection ? [result.rejection] : [],
    )
    throw new ModelRouteError(
      `No account can run ${selection.provider}/${selection.model} with the requested capabilities. ${rejections.map((reason) => `${reason.accountId}: ${reason.message}`).join(" ")}`,
      rejections,
    )
  }

  return {
    namespaces,
    async refresh() {
      let observed = refreshDirectory()
      latestRefresh = observed
      await observed
      // Admission must observe the latest projection even if its own refresh
      // was superseded by a concurrent account/configuration change.
      while (latestRefresh !== observed) {
        observed = latestRefresh
        await observed
      }
    },
    list: () => directory,
    accounts: () => accounts,
    route,
    preview,
    selectionFor(accountId: string, model: string): ModelSelection | undefined {
      for (const [identity, candidates] of bindings) {
        if (
          candidates.some(
            (candidate) =>
              candidate.accountId === accountId && candidate.model === model,
          )
        ) {
          const [provider, id] = JSON.parse(identity) as [string, string]
          return { provider, model: id }
        }
      }
      return undefined
    },
  }
}
