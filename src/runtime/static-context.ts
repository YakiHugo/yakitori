import { createHash } from "node:crypto"
import type { ProjectInstructions } from "./project-instructions.ts"
import type {
  ModelContextMessage,
  ModelSystemSection,
  ModelTarget,
} from "./model.ts"
import type { ResolvedModel } from "./model-catalog.ts"
import { getPrompt } from "./prompt-registry.ts"

export type StaticContext = {
  readonly target: ModelTarget
  readonly system: readonly ModelSystemSection[]
  readonly contextual: readonly ModelContextMessage[]
}

export function buildStaticContext(input: {
  readonly environment: string
  readonly mateInstructions: string
  readonly mateRevisionId: string
  readonly model: ResolvedModel
  readonly projectInstructions?: ProjectInstructions
}): StaticContext {
  const prompt = getPrompt(input.model.promptId)
  const system: ModelSystemSection[] = [
    {
      id: "model.instructions",
      revision: prompt.revision,
      text: prompt.text,
    },
    ...(input.mateInstructions.length === 0
      ? []
      : [
          {
            id: "agent.instructions",
            revision: input.mateRevisionId,
            text: `<agent_instructions>\n${input.mateInstructions}\n</agent_instructions>`,
          },
        ]),
    {
      id: "environment",
      revision: fingerprint(input.environment),
      text: input.environment,
    },
  ]
  const contextual =
    input.projectInstructions === undefined
      ? []
      : [
          {
            id: "project.instructions",
            revision: fingerprint(
              JSON.stringify({
                files: input.projectInstructions.files,
                message: input.projectInstructions.message,
              }),
            ),
            message: input.projectInstructions.message,
          },
        ]
  return {
    target: {
      provider: input.model.provider,
      model: input.model.model,
      promptId: input.model.promptId,
    },
    system,
    contextual,
  }
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}
