import { isJsonValue } from "../../kernel/index.ts"
import { finalizeToolContent } from "./result-output.ts"
import { plainToolName } from "./tool-name.ts"
import type { RuntimeTool } from "./types.ts"

export function createRunScriptTool(): RuntimeTool {
  return {
    toolName: plainToolName("run_script"),
    exposure: "deferred",
    effect: "opaque",
    supportsParallelToolCalls: false,
    composesTools: true,
    approvalRequirement: { kind: "none" },
    description:
      "Run an isolated JavaScript async function body. Use await tools.call(name, input) to invoke enabled tools with normal approvals and execution records. Results have ok, output and content; show(result) forwards its media to the model. print/console.log produce text. args contains the supplied JSON arguments. No ambient filesystem, network, process or timers. Await every call. The VM is fresh each run; source/arguments 64KiB each, copied output 128KiB, tool replies 2MiB, 64 calls, 64MiB heap, one second cumulative VM CPU, two minutes elapsed time (host safety boundaries).",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "JavaScript async function body. Await tools.call(name, input); use return for the final JSON value.",
        },
        arguments: {
          description:
            "JSON value available as args inside the script; defaults to null.",
        },
      },
      required: ["code"],
      additionalProperties: false,
    },
    async execute(input, context) {
      if (
        typeof input !== "object" ||
        input === null ||
        !("code" in input) ||
        typeof input.code !== "string" ||
        ("arguments" in input && !isJsonValue(input.arguments))
      )
        return {
          ok: false,
          code: "invalid_arguments",
          message: "Expected script code and optional JSON arguments.",
          content: "Expected script code and optional JSON arguments.",
        }
      const args = "arguments" in input ? input.arguments : null
      if (!isJsonValue(args))
        throw new Error("Invalid script arguments after validation.")
      const { runScript } = await import("../script/host.ts")
      const result = await runScript(input.code, args, context)
      const content = [
        ...result.text,
        result.outcome.ok
          ? JSON.stringify(result.outcome.value)
          : result.outcome.message,
      ].join("\n")
      const output = {
        ...result.outcome,
        text: result.text,
        fileObservations: result.fileObservations,
      }
      const presentation = result.shown.length
        ? {
            toModelContent: (
              budget: Parameters<typeof finalizeToolContent>[1],
            ) =>
              finalizeToolContent(
                [
                  { type: "text" as const, text: content },
                  ...result.shown.flatMap((shown) => shown.content),
                ],
                budget,
                context,
                "script-result.txt",
              ),
          }
        : undefined
      return result.outcome.ok
        ? {
            ok: true,
            output,
            content,
            ...(presentation ? { presentation } : {}),
          }
        : {
            ok: false,
            code: result.outcome.code,
            message: result.outcome.message,
            output,
            content,
            ...(presentation ? { presentation } : {}),
          }
    },
  }
}
