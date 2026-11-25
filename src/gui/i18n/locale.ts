export const languages = ["system", "en", "zh-CN"] as const

export type Language = (typeof languages)[number]
export type Locale = Exclude<Language, "system">

export function resolveLocale(
  language: Language,
  systemLanguages: readonly string[],
): Locale {
  if (language !== "system") return language

  for (const tag of systemLanguages) {
    const [base, ...subtags] = tag.toLowerCase().split("-")
    if (base === "en") return "en"
    if (base !== "zh") continue
    const [scriptOrRegion] = subtags
    if (
      scriptOrRegion === undefined ||
      scriptOrRegion === "hans" ||
      scriptOrRegion === "cn" ||
      scriptOrRegion === "sg" ||
      scriptOrRegion === "my"
    )
      return "zh-CN"
  }
  return "en"
}
