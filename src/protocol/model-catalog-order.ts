import type { ConfiguredModel } from "./providers.ts"

const textOrder = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
})

function catalogKey(id: string) {
  const normalized = id.toLowerCase()
  // Full calendar dates are presentation hints only, never model equivalence.
  // Short numeric suffixes may be versions or parameter counts, so retain them.
  const snapshot = normalized.match(
    /[-_](20\d{2})-?(0[1-9]|1[0-2])-?(0[1-9]|[12]\d|3[01])$/,
  )
  const base = snapshot ? normalized.slice(0, snapshot.index) : normalized
  return {
    base,
    family: base.match(/^[^\d]+/)?.[0] ?? base,
    date: snapshot ? Number(snapshot.slice(1).join("")) : undefined,
  }
}

// Alphabetical families, with numeric version components descending. This is
// navigation order, not a claim about quality, capability, or release recency.
function compareVersions(a: string, b: string): number {
  const first = a.match(/\d+|\D+/g) ?? []
  const second = b.match(/\d+|\D+/g) ?? []
  for (const [index, left] of first.entries()) {
    const right = second[index]
    if (right === undefined) break
    const compared = textOrder.compare(left, right)
    if (compared)
      return /^\d+$/.test(left) && /^\d+$/.test(right) ? -compared : compared
  }
  return first.length - second.length
}

export function sortModelCatalog<
  T extends Pick<ConfiguredModel, "id" | "kind">,
>(models: readonly T[], preferredIds: readonly string[] = []): T[] {
  const preferredFamilies = new Map<string, number>()
  const preferredBases = new Map<string, number>()
  for (const [index, id] of preferredIds.entries()) {
    const { family, base } = catalogKey(id)
    if (!preferredFamilies.has(family)) preferredFamilies.set(family, index)
    if (!preferredBases.has(base)) preferredBases.set(base, index)
  }
  const purpose = { chat: 0, image: 1, video: 2, other: 3 }
  const rank = (map: Map<string, number>, key: string) =>
    map.get(key) ?? preferredIds.length
  return models
    .map((model) => ({ model, ...catalogKey(model.id) }))
    .sort((a, b) => {
      const group =
        purpose[a.model.kind ?? "chat"] - purpose[b.model.kind ?? "chat"]
      if (group) return group
      const family =
        rank(preferredFamilies, a.family) - rank(preferredFamilies, b.family) ||
        textOrder.compare(a.family, b.family)
      if (family) return family
      const base =
        rank(preferredBases, a.base) - rank(preferredBases, b.base) ||
        compareVersions(a.base, b.base)
      if (base) return base
      // Undated alias first; every dated ID remains separately selectable.
      if (a.date !== b.date) {
        if (a.date === undefined) return -1
        if (b.date === undefined) return 1
        return b.date - a.date
      }
      return a.model.id < b.model.id ? -1 : a.model.id > b.model.id ? 1 : 0
    })
    .map(({ model }) => model)
}
