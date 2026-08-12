# 0019: Scope Project Instructions to the Workspace and Trim Prompt Families

## Status

Accepted on 2026-08-10. Amends decision 0018.

## Context

Decision 0018's first implementation discovered project instructions by
walking from the working directory up to the Git root. Every tool the agent
can call is constrained by a path policy rooted at the workspace, so the
instruction loader was the one component that could read files the agent
itself could not. That asymmetry is a boundary leak: rules outside the
workspace would steer behavior the agent cannot act on, and file content
outside the workspace would enter model context unchecked.

The same implementation also shipped nine prompt families, including Codex,
Gemini, Meta, reasoning-model, and Trinity variants for providers the product
does not serve. Maintaining reviewable, complete prompt resources for unused
families costs effort without benefit, and their presence implied support the
runtime never exercised.

## Decision

Project-instruction discovery is limited to the working directory. The loader
reads `AGENTS.override.md` when present, otherwise `AGENTS.md`, and never
walks parent directories or searches for a Git root. The workspace root is
also the tool path-policy root, so the loader aligns with the same boundary
instead of reading beyond it.

The prompt family is trimmed to the families that serve actual providers:
`default`, `anthropic`, `gpt`, and `kimi`. Model resolution remains catalog
data, so adding a family later is a data change — a new prompt resource plus
catalog entries — rather than a code change.

## Consequences

- No file outside the workspace enters model context through project
  instructions, matching the tool path-policy boundary.
- Instructions layered from parent directories are no longer applied; each
  workspace states its rules in its own `AGENTS.md` or `AGENTS.override.md`.
- Only actively served prompt families carry a maintenance and review burden.
- Unrecognized models fall back through catalog rules to the provider default
  or the `default` family, so resolution behavior stays data-driven.
