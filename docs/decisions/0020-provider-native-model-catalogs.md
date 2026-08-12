# 0020: Provider-Native Model Catalogs and Codex-Style Switching

## Status

Accepted on 2026-08-12. Amends decision 0019.

## Context

Decision 0017–0018 established a data-driven model catalog for prompt resolution
and next-turn model selection. The first picker implementation then sourced the
GUI model list mainly from models.dev plus a curated in-repo allowlist, applied
reasoning effort and OpenAI speed tiers across whole providers, and persisted
selection only as a per-session localStorage override.

First-party harnesses do not work that way:

- Codex loads a backend `/models` directory (Bearer + account id), caches it on
  disk, and ships a bundled snapshot. Picker effort and service tiers come from
  each ModelInfo entry. The chosen model is written to `config.toml` and frozen
  into TurnContext for the active turn.
- OpenCode combines models.dev with disk cache and a build-time snapshot, then
  stamps each message and keeps session stickiness.
- Claude Code hard-codes and bootstrap-appends models, gates effort by model
  family (Opus/Sonnet 4.6+), and persists `/model` into userSettings.
- Kimi Code exposes a small managed coding set without a public directory API.

Yakitori was over-building speeds for public OpenAI, under-using first-party
catalogs for Codex/Anthropic/Grok, and missing a user-level default equivalent
to config.toml / userSettings.

## Decision

### List sources

`src/server/model-directory.ts` is a per-provider catalog with a shared
memory TTL + disk cache + stale-on-error + 15s timeout skeleton:

| Provider   | Live source                                                                 | Fallback                                      |
| ---------- | --------------------------------------------------------------------------- | --------------------------------------------- |
| codex      | `GET {CODEX_API_BASE_URL}/models?client_version=…` (Codex OAuth)            | vendored `catalogs/codex-models.snapshot.json` |
| anthropic  | `GET https://api.anthropic.com/v1/models` (`x-api-key`)                     | vendored anthropic snapshot (opus/sonnet/haiku) |
| grok       | `GET {GROK_API_BASE_URL}/models` (OpenAI-compatible, lazy OIDC) + allowlist | vendored grok snapshot (4.5 / 4.3)             |
| openai     | models.dev + allowlist (documented exception: no public picker list)        | curated catalog entries                        |
| kimi       | curated managed three (`kimi-for-coding`, `-highspeed`, `k3`)               | n/a                                            |
| faux       | curated                                                                     | n/a                                            |

Disk cache path is `{storeRoot}/model-catalogs.json` when composed by the
application (isolated per store root), with the same shape as a user-level
`model-catalogs.json` under `YAKITORI_HOME` when constructed with defaults.
Read chain: memory fresh (1h) → disk fresh (1h) → live fetch (atomic
tmp+rename write; write failure is `console.warn` only) → memory stale → disk
any age → bundled snapshot / curated. No file lock: a single server holds
`runtime.lock`; last-writer-wins rename is enough.

Codex parsing keeps `visibility == "list"` only, maps full
`supported_reasoning_levels` (including max/ultra), `default_reasoning_level`,
and `service_tiers` (picker always offers `standard` plus declared tier ids).
Anthropic effort is gated like Claude Code: Opus/Sonnet 4.6+ get
`low|medium|high`; Haiku gets none. Grok allowlist entries get the same three
efforts. Public OpenAI entries no longer advertise speed tiers.

### `/providers` payload

Model entries are `{ id, displayName, description?, efforts?, defaultEffort?,
speeds? }`. The `family` field is removed (GUI groups by provider; `promptId`
stays server-internal via `resolveModel`). Speed appears only where the catalog
declares service tiers (today: codex).

### Switching

Kernel selection is unchanged: `input.admitted.modelSelection` freezes into
`turn.started.executionContext` and later turns inherit when omitted. The GUI
effective-model chain is:

1. last recorded turn
2. per-session override (`yakitori.modelSelections`)
3. global default (`yakitori.defaultModel`)
4. application default from `/providers`

Every picker change writes both the per-session override and the global default
(localStorage is the user-level config surface for the single GUI client). The
effort row labels the model’s `defaultEffort` as `Default (<level>)` when known;
Kimi boolean models keep on/off.

### Deferred

- Anthropic fast mode (Claude Code gates it by plan/billing): revisit when a
  first-party, non-billing-gated signal exists on the models API.
- Background catalog refresh timers: on-demand + TTL is enough.
- Config files beyond localStorage: not needed while the GUI is the only client.
- File locks on the catalog cache: only if multi-process writers appear without
  `runtime.lock`.

## Consequences

- Picker lists track first-party directories when credentials exist and degrade
  through disk and snapshots without blocking the GUI.
- Effort and speed options are model-declared rather than provider-wide
  over-application.
- New sessions inherit the last explicit user choice without rewriting kernel
  facts.
- Prompt-family resolution remains catalog-driven and stays off the public
  providers payload.
