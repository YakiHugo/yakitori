import { inputSource } from "../core/turn-input-metadata.ts"
import { inputContentText } from "../core/user-input.ts"
import { createSkillsSection } from "./native-context-sections.ts"
import {
  createLocalSkillsSource,
  loadExplicitSkillInstructions,
  renderSkillsCatalog,
  type SkillLoadInput,
  type SkillMcpServer,
  type SkillsSource,
} from "./skills.ts"
import type { PreparedStepContext } from "./turn-loop.ts"

export function createSkillsExtension(
  options: Readonly<{
    enabled?: boolean
    source?: SkillsSource
  }> = {},
) {
  const source = options.source ?? createLocalSkillsSource()
  return {
    async prepare(
      input: SkillLoadInput &
        Readonly<{ mcpServers?: readonly SkillMcpServer[] }>,
    ): Promise<PreparedStepContext> {
      // Keep the empty section to revoke a previously persisted catalog when
      // the host resumes a Session with this capability disabled.
      if (options.enabled === false)
        return { sections: [createSkillsSection(undefined)] }
      const snapshot = await source.load(input)
      const catalog = renderSkillsCatalog(snapshot)
      return {
        sections: [createSkillsSection(catalog)],
        compactionKey: catalog === undefined ? null : JSON.stringify(catalog),
        diagnostics: snapshot.diagnostics,
        async prepareInput(submitted, history, warn) {
          if (inputSource(submitted) !== "human") return []
          if (
            history.some(
              ({ item }) =>
                (item.role === "user" || item.role === "developer") &&
                item.context?.type === "skill_invocation" &&
                item.context.inputId === submitted.submissionId,
            )
          )
            return []
          const text = await loadExplicitSkillInstructions(
            inputContentText(submitted.content),
            snapshot,
            warn,
            {
              source: snapshot.resources,
              ...(input.mcpServers === undefined
                ? {}
                : { mcpServers: input.mcpServers }),
            },
          )
          return text === undefined
            ? []
            : [
                {
                  role: "user",
                  content: [{ type: "text", text }],
                  context: {
                    type: "skill_invocation",
                    inputId: submitted.submissionId,
                  },
                },
              ]
        },
      }
    },
  }
}
