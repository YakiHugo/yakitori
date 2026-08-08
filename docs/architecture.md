# Architecture Direction

This is the living architecture overview for Yakitori. Architecture decision
records under `docs/decisions/` explain why individual boundaries were chosen.

## Product Target

Yakitori is a local coding-agent workbench built from scratch. Its durable
actors are persistent-memory `Mate`s that can work alone or collaborate in
a shared task room.

The GUI may learn from Codex's task workbench, but Yakitori is not intended to
reuse any reference product wholesale. In particular, collaboration is a
domain capability inside the workbench, not a reason to clone a channel-centric
chat product.

The intended experience is:

```text
Codex-style task workbench
+ persistent Mate identity and memory
+ a shared room for multi-Mate discussion
+ one inspectable execution lane per Mate assignment
```

## Reference Roles

References inform different boundaries rather than defining one inherited
architecture:

- Codex is the primary product and system reference for the workbench, public
  Thread/Turn/Item concepts, local server boundary, terminal, diff, worktree,
  approvals, and agent activity UI.
- OpenCode v2 is the primary reference for durable input admission,
  transaction and recovery semantics, and selected implementation mechanisms.
- Grok Build is a secondary cross-check for single-owner Session persistence,
  JSONL recovery boundaries, and network-filesystem WAL hazards.
- Pi is a reference for a small model loop and provider/tool boundaries.
- Claude Code documentation and observable behavior are cross-checks for
  permissions, hooks, instructions, and terminal product behavior.
- Raft is a product-design reference for treating agents as persistent
  colleagues and for room, mention, and collaboration semantics. Yakitori does
  not inherit Raft's information architecture.
- OpenCode v1 is a legacy comparison only.

Runtime code must not depend on any local reference repository.

## Domain Map

```text
Project
|- Mates
|  |- immutable profile revisions
|  `- personal memory collections
|- project and explicitly shared memory collections
|- Rooms
|  |- members
|  |- ordered Messages
|  `- per-recipient Deliveries
`- Tasks
   |- one collaboration Room
   `- Assignments
      `- one Mate execution Session
         `- Inputs -> Turns -> recorded facts -> derived views
```

The first product version may create one Room automatically for each Task. The
entities remain distinct because a Room answers who can communicate and see
messages, while a Task answers what must be completed and what counts as a
result. This also leaves room for one stable group to handle multiple tasks
later without changing the execution model.

### Mate

A `Mate` is a durable identity, not a process, Thread, Session, model, or
subagent handle. It can participate in many Tasks and survive runtime restarts
or provider changes.

The stable identity root contains the Mate ID, lifecycle state, current
profile revision, and creation time. Name, role, instructions, personality,
model policy, and capability policy live in immutable `MateRevision`s. An
execution Session records the exact revision it uses so later profile changes
do not rewrite previous work.

`Subagent` is a relative role in one collaboration, not a separate kind of
durable identity.

### Room, Task, and Assignment

A `Room` is the shared communication and visibility boundary. It owns ordered
Messages, membership history, replies, mentions, and delivery policy.

A `Task` owns a goal, completion policy, status, and results. It is associated
with a Room but does not own an agent's tool transcript.

An `Assignment` associates one Task with one Mate and its execution
Session. Multiple Assignments may intentionally carry the same objective so
several Mates can investigate or implement the same work independently.
Task completion is decided by the user or an authorized coordinator; it is not
necessarily equivalent to every Assignment finishing.

### Execution Session

The current `Session -> Input -> Turn` kernel remains the execution lane for
one Mate assignment. It records coarse facts such as completed assistant
messages, tool calls and results, permission decisions, and honest terminal
boundaries. Item and Tool state exposed to consumers is derived from those
facts rather than persisted as a second micro-state machine. Version one keeps
at most one active Turn per execution Session while different Mates execute
concurrently in different Sessions.

A runtime activation is temporary and owns in-flight state such as streaming,
runner fibers, active tool execution, and abort handles. Process IDs, leases,
sockets, and online state are operational projections, not Mate identity. If a
process stops mid-Turn, recovery records one `turn.interrupted` fact without
inventing results for unfinished work.

## Shared Messages and Durable Delivery

A Room Message and an execution Input are different objects:

- A `Message` is the canonical content visible in the Room. It is stored once
  and has a monotonic room sequence number.
- A `Delivery` records that a particular Mate should notice or act on a
  Message. It has its own durable lifecycle and refers to the Message instead
  of copying its content.
- An execution `Input` is admitted into one Mate's Session when a Delivery
  is scheduled. It can still use the current pending, promotion, and Turn
  lifecycle.

One user request can therefore fan out safely:

```text
one Room Message
-> one Delivery per assigned Mate
-> one Input in each execution Session
-> parallel Turns
```

Room visibility does not imply an immediate model call:

- A user assignment wakes the selected Mates.
- A structured `@mention` creates a high-priority Delivery.
- A reply notifies the original author according to Room policy.
- An ordinary Mate finding is visible to every member and enters a bounded,
  low-priority catch-up path rather than waking the whole Room immediately.
- `@all` is restricted to the user or an authorized coordinator and is rate
  limited.

Mentions store stable Mate IDs. Display names are presentation data and
must not be reparsed from plain text to decide recipients.

If a target Mate is idle, a claimed Delivery may start its next Turn. If it
is busy, the Delivery is queued and injected at a safe model boundary; it must
not interrupt an in-flight tool transaction. Offline Mates retain pending
Deliveries for later recovery.

Detailed reasoning, tool output, and execution events stay in the Mate's
execution Session. A Mate explicitly publishes bounded findings, questions,
results, and artifact references to the Room. Other Mates do not
automatically ingest its private execution transcript, although the user can
inspect that lane in the GUI.

## Persistent Memory

Identity configuration and learned memory are different:

- Profile revisions define who the Mate is instructed to be.
- Working context belongs to an execution Session or Turn.
- Personal memory belongs to one Mate.
- Project memory belongs to a Project.
- Shared memory is an explicitly granted collection; there is no implicit
  global team memory.

Memory is treated as a sourced, revisable claim rather than immutable truth.
Every accepted revision has provenance, scope, author, and lifecycle state.
Automatic extraction produces a `MemoryCandidate` before it can affect durable
memory. Untrusted tool or web content cannot silently rewrite a Mate
profile, and secret values never enter memory.

Retrieval is authorized before search, bounded by hard item/token/byte limits,
and records the exact memory revisions selected for a model step in a
`ContextSnapshot`. Personal memory and permissions do not propagate through an
Assignment or mention unless an explicit grant allows it.

Unlike the append-only execution journal, memory must support correction and
deletion. Immutable event logs may record memory IDs and actions, but should not
retain deletable memory plaintext.

## Persistence and Coordination

Durable facts remain append-oriented and projections remain rebuildable. Each
execution Session owns `sessions/<sessionId>/events.jsonl`, and one complete
line records one flat fact envelope. A command may serialize several fact
lines into one buffer and synchronize once, but recovery retains any complete
line prefix rather than treating the command as a transaction. Only after
synchronization does the writer advance its in-memory projection. Input
admission reconciles retries from the stored `input.admitted` fact's request ID
and payload fingerprint; there is no generic operation receipt. A versioned
`summary.json` accelerates listing but is disposable and is trusted only when
it matches the journal byte length. Replay remains a debugging and repair
operation rather than a parallel source of truth.

One runtime lock in the canonical Session store excludes a second server, and
one per-Session I/O gate serializes journal initialization, reads, appends,
repair, and rebuild. Parallel Mates use distinct execution Sessions. SQLite
remains a fit for Mate identity and future relational collaboration
aggregates, but it does not own Session transcripts.

Operations crossing aggregates use stable IDs, idempotent commands, and a
recoverable saga or outbox. They must not assume that posting a Room Message,
creating several Deliveries, and starting execution Sessions happen in one
in-memory call.

The live event hub accelerates GUI updates; it is not the durable scheduler.
The scheduler claims Delivery state from persistence so mentions and broadcasts
survive process restarts.

## Concurrency and Safety

- Different Mate execution Sessions may run in parallel.
- One Mate and Assignment have at most one active execution attempt by
  default.
- Concurrent code-writing Assignments use isolated worktrees by default. A
  coordinator or explicit integration Assignment combines results.
- A shared live workspace requires checkpointed writes and conflict detection;
  last-writer-wins is not acceptable.
- Permission grants are bounded by user authority, workspace policy, the
  requester's delegable rights, Assignment policy, and the current tool call.
- A Mate does not inherit another Mate's personal memory, credentials,
  or approvals.

Text-file replacement goes through one Runtime-owned compare-and-write
boundary. It resolves workspace containment, serializes writers by canonical
path, checks the protocol's internal revision precondition, writes and
synchronizes a temporary file in the target directory, then resolves the path
and checks the revision again before publishing the replacement. File tools
may define different model-facing edit protocols, but they must reuse this
commit boundary instead of implementing independent write paths.

`write_file` exposes only `path` and complete desired `content`; revision hashes
remain internal Runtime state rather than model-authored arguments. A missing
target takes the atomic no-clobber creation path. Replacing an existing target
requires a complete observation in the frozen model-context view, and Runtime
uses that observation's SHA as the compare-and-write precondition. Missing,
partial, and stale observations fail with instructions to read the complete
current file before retrying.

The default `edit_file` protocol treats an empty `oldString` as an atomic
create-if-absent operation; it never overwrites an existing file and reuses the
same no-clobber commit path as `write_file`. A non-empty `oldString` performs
one flat `oldString`/`newString` replacement, with optional `replaceAll` for one
search string. Its model-facing input does not carry a revision hash: Runtime
derives the write precondition from an observation still present in the model
context that produced the edit call. It tries exact text first, then only
deterministic line-ending, straight-versus-curly quote, and trailing-whitespace
equivalence.
Single-versus-double quote delimiters, indentation, and internal whitespace
remain exact for every file format. Replacement text always adopts the file's
dominant line-ending style. If the file changed after observation, a
single-target edit may rebase only when the exact `oldString` remains unique;
`replaceAll` keeps the observed-revision requirement and is invalid for
create-if-absent. The tool never applies similarity or nearest-match guesses.

Missing-target diagnostics return only bounded, nonzero-score nearby text;
ambiguous-target diagnostics return exact line ranges without repeating the
same matched body. Diagnostics never choose a write target or encode a retry
action. Successful edits record whether they rebased and whether their changed
ranges were inside the visible observation, so the softer observed-file policy
can be monitored before deciding whether range authorization should become a
hard rule. Successful writes and edits also record a bounded unified diff in
structured output.

`read_file` opens one regular file and scans only far enough to reach the
requested 1-based page plus bounded lookahead. Reaching a line offset still
requires scanning preceding bytes because ordinary text files have no line
index, but a partial page no longer scans onward to EOF merely to compute full
metadata. `offset` is a positive integer, `limit` is explicitly bounded from 1
through 2,000, and pagination rereads the file's current contents without a
cross-page revision promise. Descriptor metadata is checked before and after
the scan so an in-place concurrent change is rejected; an atomic path
replacement may still yield the already-open inode, with later write
preconditions protecting the replacement path.

Output is capped at 2,000 lines, 2,000 characters per displayed line, and 50
KB. Only a read from line 1 that reaches EOF without byte, line, or long-line
display clipping is a complete observation and records the full SHA, byte and
line counts, newline style, and final-newline state. Partial pages carry no
revision. Every successful read result remains bounded and self-contained in
recorded facts. Model-context assembly may deduplicate identical complete read
results by showing one body and short references for the other tool calls;
live partial pages are not revision-keyed or deduplicated. Compaction and resume
recompute delivery from durable self-contained facts rather than persisting a
stub.

Direct reads reject directories, FIFOs, sockets, devices, and other non-regular
targets before opening them. Bounded command execution with a timeout is the
explicit stream-consumption path. Images and other rich media remain outside
the text-read protocol, and future additional roots must pass a Runtime path
permission boundary whose read authority does not imply write authority.
`grep` and `glob` use ripgrep, respect ignore rules, filter secret-bearing paths,
and have independent result caps. The same sensitive-path policy applies to
direct file reads and writes.
`glob` exposes only Claude-compatible `pattern` and optional `path` inputs. It
streams paths in ripgrep's traversal order and stops on the first valid path
beyond its 100-result hard cap, then sorts only the retained paths
lexicographically. Truncated selection is therefore best effort rather than a
workspace-wide top-N ordering. Its public result distinguishes result, timeout,
and output-byte truncation; a timeout with no complete path is a tool failure.
Ignored files may be enabled only through construction-time Runtime
configuration, not by a model-supplied argument.

`grep` exposes the common Claude/Kimi search surface, including context,
file-type, multiline, offset, and head-limit controls; Kimi's `count_matches`
spelling is accepted as an alias for Claude's `count`. Ignored-file discovery
is Runtime construction state rather than a model argument. `head_limit` is
bounded from 1 through the Runtime cap (250 by default), and multiline search
enables ripgrep's multiline and dotall modes together. Ripgrep output is
consumed as a stream under hard time, result, record, line, raw-byte, and
model-visible byte limits. Result and model-output limits expose a usable next
offset only after at least one complete result was returned; raw/record limits,
empty bounded pages, and timeouts do not. Runtime rejects output budgets too
small for the minimum result envelope, and an irreducible oversized envelope
fails instead of violating the configured cap. Timeout is recorded separately
from output-boundary truncation, and line shortening does not make the search
itself truncated. `grep` file lists use reverse mtime ordering; content and
counts use ripgrep's stable path ordering, with content retaining line order.

Grep `offset` pagination reruns the live search and is explicitly best effort;
it does not expose a revision or claim snapshot consistency. Stable pagination
requires a future bounded materialized result artifact rather than a token over
unrelated observation state.

File observation is one immutable request-scoped derived view. After final
context selection and tool-result truncation, Runtime projects only successful
results whose complete text is actually present in that model request. Visible
complete and ranged reads establish behavioral edit visibility; visible
whole-file writes and create-if-absent edits establish authorship. A normal edit
advances a revision only when its visible prerequisite is also present, so an
edit summary left behind after compaction cannot silently recreate authority.
Results truncated again by model-context assembly conservatively grant no
observation. All tool calls produced by one model response share the same frozen
view, so a sibling read cannot retroactively authorize an edit; the next model
request rebuilds a new view from its final context.

The journal retains original `tool.result` facts for transcript, GUI, repair,
debugging, and offline analysis, but Runtime does not rebuild a mutable file
authorization cache from the complete Session history. `grep` locates files and
lines but produces no file observation; the model must use `read_file` before
editing an existing file. A complete visible read supplies `write_file`'s
internal compare-and-write revision. A ranged read supplies no revision, so
`edit_file` rereads the current file and accepts only an exact current anchor
before committing against those current bytes. Filesystem SHA comparison at the
synchronized write boundary remains the final concurrency check.

Tool results retain the coarse durable `{ content, output?, error? }` shape.
`content` is bounded, concise plain text for the model; `output` carries
structured metadata for projections and the GUI rather than being stringified
back into model context.

Alternative model-specific protocols such as hashline or GPT-only
grammar-constrained patching must be exposed as mutually exclusive toolsets and
reuse the same compare-and-write boundary.

Agent-to-agent wakeups also require loop controls:

- each Delivery is consumed at most once
- a Mate's own Message does not wake itself
- acknowledgements do not require a model-generated reply
- causation depth, message, mention, run, token, and time budgets are bounded
- exhausted collaboration enters a visible waiting state instead of continuing
  silently

## GUI Shape

The main surface remains a coding-task workbench rather than a general chat
application. A Task view contains:

- the shared Room conversation
- participating Mates and Assignment status
- pending and mentioned activity
- expandable per-Mate execution lanes
- terminal, diff, approvals, artifacts, and worktree state
- memory citations and memory management where relevant

Permanent channel navigation, social presence, and a general-purpose task board
are not required by this architecture.

## Implementation Direction

The MVP runtime drives Turns end to end through the witness-style kernel and
per-Session JSONL journals. The product ships as an Electron desktop app whose
main process embeds the application and serves the GUI from the same local
server, same-origin (decision 0010); the HTTP API remains the only GUI↔core
channel.

Context pressure is handled by compaction: an append-only `context.compacted`
fact records the exact source boundary and a bounded checkpoint summary, and
later context builds replace covered turns with it (decision 0011). Transient
provider errors are retried with bounded backoff (decision 0012), and every
Turn's system prompt carries a bounded environment block (decision 0013).

The server keeps a project registry (`src/server/project-registry.ts`, the
Codex GUI "project" parallel): registered project directories live in
`projects.json` under `YAKITORI_HOME` (default `~/.yakitori`), with the
configured workspace always present. Each Session records its own
`workingDirectory`, and `GET /sessions?workingDirectory=` filters the list by
project; one shared Session store serves every project. Sessions can be
deleted through `DELETE /sessions/:id`; deletion removes the Session directory
and is refused with 409 while a Turn is active or Inputs are queued.

The per-fact journal decision
(`docs/decisions/0009-per-fact-journal-lines.md`) is implemented. Its historical
stage plan is archived at `docs/archive/stage-2-fact-journal.md`; the continuing
direction is `docs/kernel-persistence-direction.md`.

Collaboration contracts can then land against real execution-lane callers. The
remaining architecture-sensitive stages are:

1. Add safe-boundary steer/catch-up behavior and result publication.
2. Add Room, Task, Assignment, Message, and Delivery
   contracts and projections (decision 0006 items land here, with consumers).
3. Associate one execution Session with each Assignment and add a durable
   Delivery scheduler.
4. Add explicit memory CRUD and ContextSnapshot manifests before enabling
   conservative candidate extraction and consolidation.
5. Grow the GUI around the shared Room and inspectable execution lanes.

Embeddings, automatic memory consolidation, long-lived reusable Rooms,
distributed execution, organization-wide sharing, and autonomous Mate
profile modification remain deferred.
