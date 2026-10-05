import type { JsonValue } from "../kernel/index.ts"
import { providerPresets } from "../runtime/provider-presets.ts"
import { plainToolName } from "../runtime/tools/tool-name.ts"
import type { RuntimeTool } from "../runtime/tools/types.ts"
import { ConfigurationError } from "./config-errors.ts"
import { requireProviderConfiguration } from "./provider-configuration.ts"
import type { ProviderService } from "./provider-service.ts"
import { ConfigVersionConflictError } from "./user-config.ts"

// Neither primary reference has a model-operated provider setup boundary.
// Yakitori's explicit self-configuration requirement uses the same service as
// the GUI, so model edits receive identical validation, persistence and reload.
export function createModelSourceTool(service: ProviderService): RuntimeTool {
  return {
    toolName: plainToolName("configure_model_sources"),
    description:
      "Inspect and configure Yakitori's model sources. Start with list for presets and saved connections; keys are never returned. Preview validates a change without saving. Save accepts preset, env_key or api_key, and base_url for custom/local services. Omit id to generate a connection ID. Omit model_ids to expose all upstream models automatically; model_selection controls all/selected, model_settings supplies metadata overrides. Discover lists upstream IDs, never aliases. Refresh with id updates that source's catalog. Successful save/remove returns undoId; restore with undo_id reverses it only if no later change replaced it. Changes persist and update the GUI and subsequent turns. Only change connections at the user's request. Subscription sign-in is completed by the user in Providers.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: [
            "list",
            "discover",
            "preview",
            "save",
            "remove",
            "refresh",
            "restore",
            "move",
          ],
        },
        id: {
          type: "string",
          description: "Existing connection ID to edit/remove; omit to create.",
        },
        preset: { type: "string", description: "Preset ID returned by list." },
        name: {
          type: "string",
          description:
            "Optional display name; defaults to preset name or endpoint host.",
        },
        base_url: { type: "string" },
        api_backend: {
          type: "string",
          enum: [
            "responses",
            "chat_completions",
            "messages",
            "generate_content",
          ],
        },
        api_key: {
          type: "string",
          description:
            "New credential; never included in results. Omit to retain an existing key.",
        },
        env_key: {
          type: "string",
          description: "Environment variable containing the API key.",
        },
        no_key: {
          type: "boolean",
          description: "For a local or unauthenticated endpoint.",
        },
        enabled: { type: "boolean" },
        undo_id: {
          type: "string",
          description:
            "Undo token returned by a successful save/remove; restores that change without exposing its keys.",
        },
        before_id: {
          type: "string",
          description:
            "For move: put this connection before another ID; omit to place it last.",
        },
        model_selection: { type: "string", enum: ["all", "selected"] },
        model_settings: {
          type: "array",
          items: { type: "object" },
          description:
            "Optional upstream model metadata overrides: id, displayName, contextWindowTokens, contextWindowScope (input or total), maxOutputTokens, inputModalities, efforts and defaultEffort.",
        },
        model_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional upstream model selection. Omit to fetch the catalog automatically.",
        },
      },
    },
    exposure: "deferred",
    effect: "mutate",
    supportsParallelToolCalls: false,
    approvalRequirement: { kind: "none" },
    async execute(input) {
      try {
        if (typeof input !== "object" || input === null || Array.isArray(input))
          throw new ConfigurationError("Provide an object with an action.")
        const record = input as Record<string, unknown>
        let result: unknown
        if (record.action === "list") result = await service.read()
        else if (record.action === "restore") {
          if (typeof record.undo_id !== "string")
            throw new ConfigurationError(
              "restore requires undo_id from the change being restored.",
            )
          result = await service.restore(record.undo_id)
        } else if (record.action === "move") {
          if (
            typeof record.id !== "string" ||
            (record.before_id !== undefined &&
              typeof record.before_id !== "string")
          )
            throw new ConfigurationError(
              "move requires id and an optional before_id.",
            )
          result = await service.move(
            record.id,
            record.before_id as string | undefined,
          )
        } else if (record.action === "refresh") {
          if (typeof record.id === "string")
            result = await service.refreshModels(record.id)
          else {
            await service.reload()
            result = await service.read()
          }
        } else if (record.action === "remove") {
          if (typeof record.id !== "string")
            throw new ConfigurationError("remove requires an existing id.")
          result = await service.delete(record.id)
        } else if (
          record.action === "save" ||
          record.action === "discover" ||
          record.action === "preview"
        ) {
          const previous =
            typeof record.id === "string"
              ? (await service.read()).providers.find(
                  (entry) => entry.id === record.id,
                )?.configuration
              : undefined
          if (record.id !== undefined && previous === undefined)
            throw new ConfigurationError(
              "This connection does not exist. Omit id to create a new one.",
            )
          const preset =
            typeof record.preset === "string"
              ? providerPresets.find((entry) => entry.id === record.preset)
              : undefined
          if (record.preset !== undefined && preset === undefined)
            throw new ConfigurationError("Unknown preset. Use list first.")
          const baseURL =
            record.base_url ?? previous?.baseURL ?? preset?.baseURL
          let host = "Custom provider"
          if (typeof baseURL === "string") {
            try {
              host = new URL(baseURL).host
            } catch {
              throw new ConfigurationError("base_url must be an absolute URL.")
            }
          }
          const backend = record.api_backend
          if (
            backend !== undefined &&
            ![
              "responses",
              "messages",
              "chat_completions",
              "generate_content",
            ].includes(String(backend))
          )
            throw new ConfigurationError("Unknown API backend.")
          const configuration = requireProviderConfiguration({
            ...previous,
            name: record.name ?? previous?.name ?? preset?.name ?? host,
            baseURL,
            wireApi:
              backend === "responses"
                ? "openai_responses"
                : backend === "messages"
                  ? "anthropic_messages"
                  : backend === "chat_completions"
                    ? "openai_chat_completions"
                    : backend === "generate_content"
                      ? "gemini_generate_content"
                      : (previous?.wireApi ??
                        preset?.wireApi ??
                        "openai_chat_completions"),
            preset: preset?.id ?? previous?.preset,
            envKey: record.env_key ?? previous?.envKey ?? preset?.envKey,
            noKey: record.no_key ?? previous?.noKey ?? preset?.noKey,
            enabled: record.enabled ?? previous?.enabled,
            modelSelection:
              record.model_selection ??
              (record.model_ids === undefined
                ? previous?.modelSelection
                : "selected"),
            models:
              record.model_settings !== undefined
                ? record.model_settings
                : record.model_ids === undefined
                  ? (previous?.models ?? [])
                  : Array.isArray(record.model_ids)
                    ? record.model_ids.map((id) => ({
                        ...preset?.models.find((model) => model.id === id),
                        ...previous?.models.find((model) => model.id === id),
                        id,
                      }))
                    : record.model_ids,
          })
          if (
            record.api_key !== undefined &&
            typeof record.api_key !== "string"
          )
            throw new ConfigurationError("api_key must be a string.")
          const params = {
            configuration,
            ...(typeof record.id === "string" ? { id: record.id } : {}),
            ...(typeof record.api_key === "string"
              ? { apiKey: record.api_key }
              : {}),
          }
          result =
            record.action === "preview"
              ? await service.preview(params)
              : record.action === "save"
                ? await service.write(params)
                : await service.discover(params)
        } else
          throw new ConfigurationError(
            "Unknown action. Use list, discover, preview, save, remove, refresh or restore.",
          )
        return {
          ok: true,
          output: result as JsonValue,
          content: JSON.stringify(result),
        }
      } catch (cause) {
        if (
          !(
            cause instanceof ConfigurationError ||
            cause instanceof ConfigVersionConflictError
          )
        )
          throw cause
        return {
          ok: false,
          code: "model_source_configuration",
          message: cause.message,
          content: cause.message,
        }
      }
    },
  }
}
