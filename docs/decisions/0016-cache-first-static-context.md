# 0016: Build Static Model Context as a Cache-First Prefix

## Status

Superseded by decision 0017 on 2026-08-10. This decision remains the record of
the first cache-first static-context implementation and supersedes decision
0015.

## Context

Decision 0015 introduced one provider-neutral system string. That supplied a
coding-agent contract, but it erased the boundaries between reusable harness
instructions, model-specific guidance, Mate instructions, and environment
state. It also left project instructions for the model to discover with tools.

Provider prompt caches are prefix-sensitive. Reordering or joining unrelated
dynamic content ahead of stable instructions reduces cache reuse, while sending
Anthropic-compatible extensions to every compatible endpoint risks protocol
breakage. Different model families also benefit from focused guidance, and the
selected guidance must follow the Turn's recorded provider and model.

## Decision

Ordinary model requests carry four explicit surfaces:

1. ordered system blocks with stable IDs;
2. a flattened system string for provider compatibility;
3. contextual user messages for bounded project instructions;
4. native tool definitions, separate from prompt prose.

System blocks are ordered from most reusable to most session-specific:

1. the harness coding-agent contract;
2. one model-family prompt selected from provider and model identifiers;
3. the immutable Mate revision's optional instructions;
4. the Turn's bounded environment block.

The model selector follows OpenCode's model-first shape: Muse Spark, GPT-4 and
o1/o3 reasoning models, GPT Codex, other GPT, Gemini, Claude, Kimi, Trinity,
and Grok are recognized from the model identifier. The provider is only a
fallback for opaque model identifiers. Selection is a pure function and a new
Turn records the provider and model that determined the prompt.

The model-family and environment block endings are cache breakpoints. Official
Anthropic requests additionally mark the final tool definition and the final
contextual project-instruction block. This produces at most four cumulative
breakpoints: tools, reusable system prefix, complete system, and complete
static context. Anthropic-compatible providers such as Kimi retain the plain
string system request and receive no Anthropic cache-control extensions.
OpenAI-compatible providers receive the flattened system string in stable
prefix order and rely on provider automatic prefix caching.

Project instructions are discovered from the nearest Git root through the
working directory. Each directory contributes at most one file, preferring
`AGENTS.override.md` over `AGENTS.md`; without a Git root, only the working
directory is considered. File contents share a 32 KiB byte budget and are
injected as one contextual user message. Discovery happens once per Turn, so
all model calls in that Turn use identical bytes.

Detailed tool semantics remain in tool descriptions and JSON Schemas. The
system prompt owns only cross-tool behavior.

## Consequences

- Stable prompt prefixes remain byte-identical across ordinary model calls and
  across Sessions that share a model and toolset.
- Model changes select a corresponding prompt without changing provider
  adapters or the agent loop.
- Project rules are available before the first tool call without receiving the
  same authority as harness instructions.
- The internal request keeps semantic block boundaries while existing provider
  and test integrations can continue inspecting the flattened system string.
- Prompt-context persistence and cross-Turn world-state diffs remain deferred;
  recorded Turn attribution and deterministic assembly are the current repair
  boundary.
