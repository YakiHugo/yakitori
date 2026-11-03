import type { ConfiguredModel } from "../protocol/providers.ts"

// Exact Claude Code choices, verified 2026-11-03. Aliases below are API aliases,
// not Claude Code's account/provider-dependent `opus`, `best`, or `opusplan`.
// https://support.claude.com/en/articles/11940350-claude-code-model-configuration
// https://platform.claude.com/docs/en/models/overview (including legacy pages)
// https://platform.claude.com/docs/en/build-with-claude/thinking
// https://platform.claude.com/docs/en/build-with-claude/effort
const levels = ["low", "medium", "high", "xhigh", "max"]
const standardLevels = ["low", "medium", "high", "max"]

type ClaudeModel = Readonly<{
  configuration: ConfiguredModel
  visionTier: "standard" | "high"
  thinking: "adaptive" | "extended"
  off: "disabled" | "between_tools" | false
  forcedTools: boolean
}>

const definitions: readonly [
  id: string,
  name: string,
  context: number,
  output: number,
  vision: ClaudeModel["visionTier"],
  thinking: ClaudeModel["thinking"],
  off: ClaudeModel["off"],
  efforts: readonly string[],
  defaultEffort?: string,
][] = [
  [
    "claude-sonnet-5-5",
    "Claude Sonnet 5.5",
    1_000_000,
    128_000,
    "high",
    "adaptive",
    "between_tools",
    levels,
    "high",
  ],
  [
    "claude-opus-5-5",
    "Claude Opus 5.5",
    1_000_000,
    128_000,
    "high",
    "adaptive",
    false,
    levels,
    "medium",
  ],
  [
    "claude-haiku-5-5",
    "Claude Haiku 5.5",
    1_000_000,
    128_000,
    "high",
    "adaptive",
    "disabled",
    levels,
    "medium",
  ],
  [
    "claude-fable-5-1",
    "Claude Fable 5.1",
    1_000_000,
    128_000,
    "high",
    "adaptive",
    false,
    levels,
    "high",
  ],
  [
    "claude-opus-5",
    "Claude Opus 5",
    1_000_000,
    128_000,
    "high",
    "adaptive",
    "disabled",
    levels,
    "high",
  ],
  [
    "claude-sonnet-5",
    "Claude Sonnet 5",
    1_000_000,
    128_000,
    "high",
    "adaptive",
    "disabled",
    levels,
    "high",
  ],
  [
    "claude-fable-5",
    "Claude Fable 5",
    1_000_000,
    128_000,
    "high",
    "adaptive",
    false,
    levels,
    "high",
  ],
  [
    "claude-opus-4-8",
    "Claude Opus 4.8",
    1_000_000,
    128_000,
    "high",
    "adaptive",
    "disabled",
    levels,
    "high",
  ],
  [
    "claude-opus-4-7",
    "Claude Opus 4.7",
    1_000_000,
    128_000,
    "high",
    "adaptive",
    "disabled",
    levels,
    "high",
  ],
  [
    "claude-sonnet-4-6",
    "Claude Sonnet 4.6",
    1_000_000,
    128_000,
    "standard",
    "adaptive",
    "disabled",
    standardLevels,
    "high",
  ],
  [
    "claude-opus-4-6",
    "Claude Opus 4.6",
    1_000_000,
    128_000,
    "standard",
    "adaptive",
    "disabled",
    standardLevels,
    "high",
  ],
  [
    "claude-opus-4-5-20251101",
    "Claude Opus 4.5",
    200_000,
    64_000,
    "standard",
    "extended",
    "disabled",
    ["low", "medium", "high"],
    "high",
  ],
  [
    "claude-haiku-4-5-20251001",
    "Claude Haiku 4.5",
    200_000,
    64_000,
    "standard",
    "extended",
    "disabled",
    [],
  ],
  [
    "claude-sonnet-4-5-20250929",
    "Claude Sonnet 4.5",
    200_000,
    64_000,
    "standard",
    "extended",
    "disabled",
    [],
  ],
]

const models = new Map<string, ClaudeModel>(
  definitions.map(
    ([
      id,
      displayName,
      contextWindowTokens,
      maxOutputTokens,
      visionTier,
      thinking,
      off,
      efforts,
      defaultEffort,
    ]) => [
      id,
      {
        configuration: {
          id,
          displayName,
          contextWindowTokens,
          maxOutputTokens,
          inputModalities: ["text", "image"],
          imageDetailModes: ["high", "original"],
          // `off` is a harness thinking control, never output_config.effort.
          efforts:
            thinking === "adaptive" && off ? ["off", ...efforts] : efforts,
          ...(defaultEffort === undefined ? {} : { defaultEffort }),
        },
        visionTier,
        thinking,
        off,
        forcedTools: ![
          "claude-fable-5-1",
          "claude-opus-5-5",
          "claude-sonnet-5-5",
        ].includes(id),
      },
    ],
  ),
)

export const anthropicCodeModels: readonly ConfiguredModel[] = [
  ...models.values(),
].map((model) => model.configuration)

export function anthropicModel(model: string): ClaudeModel | undefined {
  const aliases: Record<string, string> = {
    "claude-opus-4-5": "claude-opus-4-5-20251101",
    "claude-haiku-4-5": "claude-haiku-4-5-20251001",
    "claude-sonnet-4-5": "claude-sonnet-4-5-20250929",
  }
  return models.get(aliases[model] ?? model)
}
