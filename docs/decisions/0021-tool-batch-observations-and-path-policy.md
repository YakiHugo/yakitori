# 0021: Tool-Batch Write Overlay, Structured Observations, and Path Policy

## Status

Accepted on 2026-08-13. Amends the file-observation and path-policy sections
of `docs/architecture.md`.

## Context

File authorization was a frozen snapshot built by duck-typing tool `output`
fields. That snapshot was shared by every tool call in one model response.
Two writes to the same path in one response therefore treated the second
write as an external change. A later ranged read of a file that already had
a complete visible revision also dropped that revision.

Path policy mixed workspace containment, a hardcoded secret-filename
blocklist, ripgrep exclude globs, and a full-workspace typo scan. The
containment check treated any relative path starting with `..` as an escape,
so a file named `..hidden` was denied. Claude Code and OpenCode keep secrets
out of search with gitignore and optional user deny rules rather than a
tool-level filename blocklist. OpenCode's containment test only rejects `..`
and `..${sep}`.

Models commonly issue several observe-only tools in one response. Those
calls were executed strictly in series.

## Decision

### Structured grants

Successful `read_file`, `edit_file`, and `write_file` results carry a
`fileObservation` grant. Runtime applies grants through one merge function.
Historical results without the field are inferred from the existing output
shape so resume does not rewrite durable history.

A complete read is sticky: a later ranged read in the same derived view
keeps the SHA and completeness and only records additional visible ranges.

### Same-response overlay

The context snapshot stays frozen for the response that produced the batch.
A sibling `read_file` still does not authorize an edit. After a successful
`edit_file` or `write_file`, Runtime applies that write grant to an
in-memory overlay so a later mutate in the same response can continue from
the just-written revision.

Observe-only tools before the first mutating or opaque call run
concurrently. Their results are recorded in model order. Remaining calls
stay serial.

### Path policy

Workspace containment follows OpenCode: a path is inside the workspace when
`relative(root, path)` is empty, or is not absolute and is neither `..` nor
prefixed by `..${sep}`. Input may contain `.` or `..` segments; the sandbox
is the resolved location, not the lexical spelling. New-file writes report
the canonical workspace-relative path of the real parent plus basename so
observation grants match later reads through symlinks.

Hardcoded secret path blocks and ripgrep secret globs are removed. Grep and
glob keep VCS directory excludes and honor gitignore. User deny rules are a
later permission-surface item, not a second filename list inside the tools.

Missing-path suggestions list only the parent directory, return at most
three ranked names, and time out after one second.

`read_file` on a directory returns a bounded listing and grants no file
observation.

## Consequences

- Same-response `read` + `edit` of one file still fails `file_not_observed`.
- Same-response sequential edits of an already-visible file no longer
  false-rebase against the pre-batch SHA.
- `.env` is readable and searchable unless gitignore or a future user deny
  rule hides it.
- A later user deny surface should live in Runtime permission policy, not
  in `path-policy.ts` string lists.
