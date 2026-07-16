# 0001: Use a Codex-Style Session/Turn/Item Core

## Status

Accepted as the initial execution-kernel direction. Decision 0004 extends this
model with persistent Workmates and shared Room collaboration.

## Current Scope

`Session -> Turn -> Item` remains the durable execution lane for one Workmate
Assignment. It is no longer the complete top-level product model: Room, Task,
Assignment, Message, and Delivery are separate collaboration concepts defined
by decision 0004.

## Context

Yakitori is a from-scratch coding-agent harness. The project will learn from
Codex, opencode, Claude Code public documentation and observable behavior,
ChinaSiro/claude-code-sourcemap as an unofficial research reference, Gemini CLI,
Qwen Code, Kimi Code, Mistral Vibe, Aider, Cline, Kiro, OpenHands, and cloud
agents such as Jules and GitHub Copilot coding agent.

These projects have overlapping product goals, but they expose different
implementation primitives. Yakitori needs a small first core that can grow
without becoming a wrapper around any one existing agent.

## Decision

Yakitori will use a Codex-style core shape:

```text
Session -> Turn -> Item
Event log -> Projection -> Replay
Tool call -> Permission decision -> Tool result
```

Codex is the primary execution and workbench reference for the first
implementation stage:

- a durable execution aggregate
- turns as the unit of input-driven execution
- items as the persisted units inside a turn
- append-oriented event history
- replayable local persistence
- a core/server boundary that can later support a GUI

Yakitori will keep the existing `Session` name in project language, while
borrowing Codex's `Turn` and `Item` layering. This avoids committing to Codex's
exact `Thread` naming while preserving the useful shape.

## Boundaries

Yakitori is not a fork or shell around Codex, Claude Code, Gemini CLI, Qwen
Code, Kimi Code, Mistral Vibe, Aider, or any other coding agent.

Provider-specific wire formats must not become core model types. OpenAI
Responses API items, Anthropic content blocks, Gemini function calls, and other
provider details may be stored as opaque provider metadata, but the core model
should stay provider-neutral.

External coding agents may be integrated later as tools, subagents, or backend
adapters. Their internal transcripts are not Yakitori history. Yakitori should
record the adapter invocation, inputs, outputs, file changes, status,
permissions, interruptions, and errors in its own event log.

Yakitori's durable event logs are the source of truth for replay, debugging,
GUI inspection, and evaluation. Session history is one such log; later domain
aggregates keep their own durable facts and projections.

## Deferred Ideas

opencode's deeper runtime concepts are valuable but should come after the first
event/session kernel exists:

- durable event envelopes with aggregate sequence numbers
- read-model projectors
- prompt admission and promotion
- system context sources
- context epochs
- mid-conversation system messages

Claude Code, Kiro, Cline, and similar tools are useful references for product
semantics:

- permissions
- hooks
- subagents
- memory
- rules and instruction files

Aider is a useful reference for repository context and git-native workflows,
especially repo maps.

Cloud agents such as Jules, Codex Cloud, Devin, and GitHub Copilot coding agent
are useful references for a later asynchronous worker model:

```text
worktree or sandbox -> task execution -> event stream -> branch or pull request
```

## Consequences

The first implementation module should focus on a narrow, replayable kernel:

- create a session
- append a turn
- record structured events
- project events into session state
- read the event log back

Later modules can add tools, permissions, model providers, MCP, external agent
adapters, server APIs, and GUI surfaces without discarding these execution
facts. Decision 0004 adds collaboration facts around the execution kernel.
