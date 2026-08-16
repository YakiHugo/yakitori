# 0023: Run Commands Through the User Shell Without Approval

## Status

Accepted on 2026-08-16.

## Context

`run_command` used Node's implicit `shell: true`, which selects `/bin/sh` on
POSIX instead of the user's supported shell. Finder-launched Electron also
inherits a sparse environment, the child environment filter missed common
credentials, and prefix-only model truncation routinely hid compiler and test
failure tails. The tool always requested permission even though the product's
coding-agent execution model is now immediate host-authority execution.

A command tool needs pipelines and heredocs, so an argv-only contract is not a
replacement. An OS sandbox, persistent shell, background jobs, PTY, and crash
reaping would each introduce a separate execution model and are not part of
this stage.

## Decision

`run_command` remains an opaque command-string tool. It accepts required
`command`, optional per-call in-workspace `cwd`, integer `timeoutSeconds`, and a
one-line display `description`. POSIX launches the verified user `zsh`, `bash`,
`sh`, or `dash` as `shell -c command`; Windows remains best-effort through
Node's shell support. Cwd never persists between calls.

After the server starts listening, Runtime probes the selected shell once with
a non-interactive login invocation. A NUL-delimited `env -0` result is
preferred, with `printenv` as a fallback. The frozen result supplies the PATH
missing from desktop launches. Rich application PATH values win over the
probe; sparse application PATH values do not. Command environments strip
common token, credential, password, private-key, database URL,
`YAKITORI_*`, and `ELECTRON_*` variables, then set `TERM=dumb`, `NO_COLOR=1`,
`FORCE_COLOR=0`, and canonical `PWD`. Environment maps are never recorded.

The tool is `autoAllow: true`. It runs immediately with the host user's file,
process, and network authority. Runtime first applies a small, fail-open
catastrophic-command fuse for obvious root removal, disk wipe, host halt, and
fork-bomb forms. A match records `command_blocked` and starts no process. The
fuse is explicitly bypassable and is not a sandbox or a general command safety
classifier.

Commands retain at most 1 MiB of combined stdout and stderr while continuing
to drain both streams. Streams with a NUL byte in the first 8 KiB receive a
bounded replacement preview and binary metadata. Durable structured output records exit, signal,
stdout, stderr, capture truncation, timeout, duration, cwd, shell, warnings,
and optional blocked/binary metadata. Non-zero exit remains a successful
observation. Spawn errors, timeout, abort, invalid cwd, and fuse matches are
tool failures; an abort result causes the runner's existing cancelled Turn
boundary.

Model-facing content is independently capped at 50 KiB and 2,000 lines with
one combined 30% head / 70% tail view. Its marker explains that omitted bytes
are not retained for the model and recommends redirecting to a workspace file
and reading it. Because `run_command` content already satisfies the generic
tool-result limits, later context assembly does not truncate its tail again.

Timeout and abort terminate the POSIX process group with SIGTERM followed by
SIGKILL after the existing grace period and drain pipes through close. Runtime
keeps only in-memory child state. It does not add a crash-reap lease.

Prompt families prefer native file tools for file work and reserve
`run_command` for git, package managers, builds, and tests. The GUI renders the
structured result as a terminal card with cwd, duration, output channels, and
exit/signal/timeout/truncation/blocked/binary badges.

## Consequences

- Desktop commands see the user's normal tool PATH after the asynchronous
  probe without delaying the listening boundary.
- Command execution no longer emits permission facts. The kernel permission
  vocabulary and ApprovalBar remain for a later cleanup decision.
- A malicious or indirect command can bypass the fuse. A future OS sandbox can
  wrap the launcher without changing this tool schema.
- Detached descendants may survive an abrupt sidecar crash, matching the prior
  behavior. Normal timeout, abort, and `SessionRunner.close` still reap the
  in-memory process group.
- Oversized bytes beyond the capture cap are irrecoverable unless the command
  writes them to a workspace file.
