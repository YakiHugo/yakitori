# 0018: Persist Next-Turn Model Selection and Cache Dynamic History

## Status

Accepted on 2026-08-10. Supersedes decision 0017. Amended by decisions 0019
and 0022.

## Context

Decision 0017 established the provider-neutral request, data-driven model
catalog, complete prompt resources, and adapter-owned cache syntax. Its first
implementation still selected one application-wide provider/model for every
Turn, registered only that adapter in production, and spent Anthropic's fourth
cache breakpoint on project instructions. The latter left tool-loop history
uncached even though it is the growing prefix across repeated model calls.

The first prompt resources also shared one small generic outline. OpenCode's
current prompt families instead reuse a common coding-agent contract while
changing their operational structure: Codex emphasizes editing and workspace
hygiene, Claude professional objectivity, Gemini mandates and primary
workflows, Kimi prompt/tool discipline, and reasoning models a staged workflow.

Prompt files are runtime assets. The library build could inline them, but the
Electron main build preserved relative file URLs without emitting the files.
Project-instruction discovery also continued after unexpected read failures,
which made the model run without instructions the runtime had attempted to
apply.

## Decision

`input.admitted` may record an optional `modelSelection` with a provider and
model. The selection applies to the Turn promoted from that Input. When it is
absent, Runtime inherits the most recent Turn's frozen target, falling back to
the application default for the first Turn. `turn.started.executionContext`
continues to freeze provider, model, and prompt ID, so an active Turn never
switches underneath its tool loop. Older input facts and admission fingerprints
without `modelSelection` retain their previous shape.

The application registers every explicitly injected adapter plus adapters
whose provider credentials are configured. Grok uses one lazy adapter for both
primary and switched Turns; it resolves an API key or the Grok CLI OIDC token
at each call so token expiry is not frozen at startup. Input admission rejects
any other selected provider that is not registered. The provider registry
routes each model request from its frozen target; provider-specific request
JSON remains outside the kernel and runtime model contract.

Complete Markdown prompt resources follow the operational structures of the
corresponding reference families while using Yakitori's actual capabilities
and boundaries. Model resolution remains catalog data. Prompt prose does not
contain provider routing or cache logic.

Official Anthropic requests use at most four explicit cumulative cache
breakpoints: the final tool definition, the first and final system sections,
and the latest cacheable block in dynamic conversation history. If dynamic
history is empty, the last contextual block is the fallback. Anthropic-
compatible providers receive no Anthropic cache extension unless explicitly
supported. OpenAI continues to rely on byte-stable prefixes and automatic
caching.

The Electron build emits every prompt Markdown file beside the main bundle and
verifies that emitted bytes equal the source resources. Unexpected project-
instruction discovery errors fail the active Turn before a provider call;
ordinary missing instruction files remain a successful empty discovery result.

## Consequences

- Model changes are durable next-Turn inputs rather than mutable global state.
- A selected model's prompt and adapter change together and remain frozen for
  the full Turn.
- Repeated Anthropic tool-loop calls can reuse both static context and preceding
  dynamic history.
- Prompt-family differences are reviewable content structure rather than
  hard-coded branches.
- Desktop startup cannot succeed with prompt resources silently absent, and an
  unreadable project instruction cannot be silently ignored.
