# 0017: Resolve Model Prompts Before Freezing Turn Static Context

## Status

Superseded by decision 0018 on 2026-08-10. This decision remains the record of
the first catalog-backed static-context implementation and supersedes decision
0016.

## Context

Decision 0016 separated system blocks, contextual project instructions, and
native tools, but placed model-family prompt text, model-name conditionals, and
provider cache breakpoints in one TypeScript module. That made prompt content
difficult to review, made known-model changes require control-flow edits, and
leaked Anthropic request syntax into the provider-neutral model request.

The existing references provide narrower mechanisms that fit the current
coding-agent stage. Codex resolves model-owned instructions before constructing
its provider request. OpenCode keeps complete model-family prompts in text
resources and uses ordered model-first fallback selection. Claude Code keeps
stable prompt sections separate from volatile conversation state and memoizes
the stable sections.

## Decision

Yakitori uses one provider-neutral `ModelRequest` with five surfaces:

1. a resolved target containing provider, model, and prompt ID;
2. ordered, revisioned system sections;
3. ordered, revisioned contextual user messages;
4. dynamic conversation messages;
5. native tool definitions.

The bundled model catalog is data, not model-specific control flow. Resolution
first checks an exact provider/model entry, then applies the ordered OpenCode-
style model fallback rules, then a provider default, and finally the generic
prompt. The selected prompt ID is written to new Turn execution contexts; old
facts without this field remain readable.

Complete coding-agent prompts live as Markdown resources and are loaded lazily
through a prompt registry. Their content hash is the prompt revision. A prompt
contains the complete model-family coding-agent contract rather than a small
overlay over a second hidden contract.

At Turn start the runtime freezes one static-context snapshot containing the
selected model prompt, the immutable Mate revision's coding-agent instructions,
the bounded environment, bounded project instructions, and the enabled native
tool definitions. All model steps in that Turn reuse these exact values. Each
step still rebuilds dynamic conversation history, including new assistant tool
calls, tool results, and compaction checkpoints.

Provider adapters own wire conversion and cache syntax. OpenAI receives one
flattened instructions string and relies on automatic prefix caching. Official
Anthropic requests mark the last tool, the first and final system sections, and
the final contextual instruction, producing at most four cumulative cache
points. Anthropic-compatible providers receive no cache-control extension
unless explicitly supported. A provider registry routes the resolved target to
the registered adapter.

## Consequences

- The core request preserves authority and source boundaries without depending
  on one provider's JSON shape.
- Adding a known model or changing fallback order is a catalog change; changing
  prompt prose is a Markdown resource change.
- A Mate is treated as the current coding agent at this stage. Only its
  immutable revision instructions enter static context; memory and Room state
  do not.
- Static request bytes remain stable across the tool loop, while a new Turn can
  observe model, Mate revision, environment, project-instruction, or toolset
  changes.
- Prompt resources are bundled application assets and never depend on local
  reference repositories.
