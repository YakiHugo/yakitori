# 0015: Establish a Stable Coding-Agent System Prompt

## Status

Superseded by decision 0016 on 2026-08-09. This decision remains the record of
the first provider-neutral prompt implementation.

## Context

The runner previously sent only the selected Mate revision's instructions and
the derived environment block as its system prompt. The default Mate happened
to contain one short coding preference, but the harness had no stable contract
for investigation, tool use, workspace hygiene, verification, or honest
reporting. A Mate with empty instructions therefore received no coding-agent
behavior guidance at all.

Tool definitions already carried their executable JSON Schemas, but some
optional fields had no model-facing descriptions and `write_file` carried a
global documentation policy unrelated to its execution contract.

## Decision

Every ordinary model call receives one provider-neutral system string composed
in this order:

1. stable harness-owned coding-agent instructions;
2. the immutable Mate revision's optional instructions;
3. the bounded derived environment block from decision 0013.

The stable layer defines working, tool-use, workspace-hygiene, verification,
and communication behavior. It tells the model to discover applicable project
instruction files, while the files themselves remain ordinary bounded tool
observations until a dedicated instruction-discovery boundary is implemented.

Detailed invocation semantics remain next to each tool in its description and
property-level JSON Schema descriptions. The system prompt states only the
cross-tool selection rules. Tool descriptions must describe capability and
safety contracts; unrelated product policy does not belong in them.

The base prompt is provider-neutral. Provider-specific prompt variants are
deferred until measured model behavior demonstrates a concrete incompatibility
that cannot be expressed through the common model and tool contracts.

## Consequences

- Empty or minimal Mate profiles still produce a competent coding-agent
  request.
- Mate identity stays configurable without owning the harness's safety and
  execution contract.
- OpenAI and Anthropic receive the same semantic prompt through their native
  system/instructions fields.
- The complete prompt remains bounded by construction: the stable text and
  environment have fixed size, and Mate instructions retain their existing
  32,000-character limit.
