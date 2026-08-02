# 0013: Give the Model a Bounded Environment Context Block

## Status

Accepted on 2026-07-31.

## Context

The system prompt sent with every model call was exactly the Mate revision's
instructions. The model had no durable idea of where it was working, on what
platform, or what day it was — every mature coding agent (Claude Code, Codex,
others) injects a small environment block because tool use depends on it:
relative paths, shell behavior, and date-sensitive reasoning all change with
the environment.

## Decision

Once per Turn, the runner appends a bounded `<environment>` block to the Mate
revision's instructions:

```text
<environment>
Working directory: /path/to/workspace
Is directory a git repo: yes
Platform: darwin
OS version: 24.5.0
Today's date: 2026-07-31
</environment>
```

- The block is derived, never recorded: `turn.started` already records the
  working directory, provider, and model; re-recording the rendered block
  would duplicate durable data.
- Authority order is instructions first, environment second, in the single
  `system` string both providers already accept.
- It is computed without child processes: the git-repo flag is an
  `existsSync(".git")` check. Context assembly stays synchronous and cheap.
- The block is bounded by construction (five short lines), satisfying the
  model-context rule that everything injected has a hard cap.

## Rejected Alternatives

- **A separate leading user message.** System placement keeps the authority
  gradient clear and matches both providers' native field; a user message
  would read as user-authored content.
- **Git branch/status via `git` exec.** Spawning a shell during context
  assembly adds latency and failure modes for marginal value; the model can
  ask through `run_command` when it needs branch state.
- **Per-model-call refresh.** Within one Turn the environment is stable
  enough; the date is the only drifting field and a Turn rarely crosses
  midnight. Per-Turn freshness is the honest granularity.

## Consequences

- Tool calls get correct path and platform grounding with no durable-format or
  API changes; sessions recorded before this change replay identically.
