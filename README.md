# Yakitori

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-CN.md">简体中文</a>
</p>

Yakitori is a from-scratch learning project for building a coding-agent harness
and GUI. The goal is to understand the runtime pieces behind modern coding-agent
products by implementing them directly, one module at a time.

The project is inspired by public references from opencode, Codex, and Claude
Code behavior/docs, but it does not wrap or depend on an existing agent
framework.

## Goals

- Build a local coding-agent harness from first principles.
- Keep the harness core responsible for sessions, turns, events, tools,
  permissions, persistence, and replay.
- Build a GUI that can inspect the harness while it runs.
- Record enough structured state to support debugging, replay, and evaluation.
- Keep each module small enough to understand and replace.

## Non-goals

- Do not use LangGraph, AutoGen, OpenAI Agents SDK, Claude Agent SDK, or similar
  orchestration frameworks.
- Do not make runtime code depend on local reference repositories.
- Do not clone product behavior wholesale. Reference projects are used for
  comparison and learning.

## Reference Material

Local reference material may live under `.references/`, which is ignored by
git. Current intended references are:

- `opencode`
- `openai/codex`
- Public Claude Code documentation and observable behavior

Reference material is not part of the project source tree and should not be
required to build, test, or run Yakitori.

## Current Status

This repository is at the project bootstrap stage. The package manager, runtime
layout, server shape, GUI stack, and test runner are still intentionally open.

The first implementation module should be small and runnable locally. A likely
starting point is the session/event kernel:

- create a session
- append a turn
- write structured events
- read the event log back
- expose enough state for the future GUI

## Expected Shape

The project will likely grow around these areas:

```text
core        session, turn, item, event, replay primitives
runtime     agent loop, model adapter boundary, tool execution
tools       built-in permission-checked tools
storage     event log and persisted state
server      local API used by the GUI
gui         workbench for sessions, turns, events, and tool calls
evals       scenarios and replay-based checks
```

This is a direction, not a committed layout. Update this section once the first
module lands.

## Development

There are no install, build, test, or run commands yet. Once the first module is
added, document the exact commands here and in `AGENTS.md`.

## Agent Instructions

See `AGENTS.md` for repository maintenance rules, style guidance, reference
boundaries, and testing expectations.
