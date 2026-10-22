import type {
  ApiProviderModel,
  ApiProviderSummary,
} from "../protocol/application.ts"
import type { ModelSelection } from "../protocol/events.ts"
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
  speeds?: readonly string[]
}>

export class ModelRouteError extends Error {}

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
          ...(model.speeds === undefined ? {} : { speeds: model.speeds }),
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
          instructionProfileId: first.instructionProfileId,
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
          ...(first.defaultEffort && efforts.includes(first.defaultEffort)
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

  function route(
    selection: ModelSelection,
    requirements: Readonly<{
      image?: boolean
      preferredAccount?: string
    }> = {},
  ): ModelSelection {
    const candidates = bindings.get(key(selection))
    if (!candidates?.length)
      throw new ModelRouteError(
        `No connected account provides ${selection.provider}/${selection.model}.`,
      )
    const ordered = [...candidates].sort(
      (a, b) =>
        Number(b.accountId === requirements.preferredAccount) -
        Number(a.accountId === requirements.preferredAccount),
    )
    for (const candidate of ordered) {
      if (!input.registry.providers.includes(candidate.accountId)) continue
      const models = input.registry.models(candidate.accountId)
      const target = {
        ...selection,
        provider: candidate.accountId,
        model: candidate.model,
      }
      let model: ReturnType<typeof models.resolve>
      try {
        model = models.resolve(target)
      } catch (error) {
        if (
          error instanceof ModelNotConfiguredError ||
          error instanceof NonChatModelError
        )
          continue
        throw error
      }
      if (requirements.image && !model.inputModalities.includes("image"))
        continue
      if (
        selection.effort !== undefined &&
        !model.efforts?.includes(selection.effort)
      )
        continue
      if (
        selection.speed !== undefined &&
        !candidate.speeds?.includes(selection.speed)
      )
        continue
      models.validate(target)
      return target
    }
    throw new ModelRouteError(
      `No account can run ${selection.provider}/${selection.model} with the requested capabilities.`,
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
