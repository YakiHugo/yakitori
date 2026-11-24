# Testing contracts

Choose the lowest stable boundary that can observe the failure. A directory
named `gui` does not imply that a contract needs a rendered component.

## Ownership

- **Execution and recovery:** `runtime/turn-processor.test.ts` and
  `runtime/durable-turn-contracts.test.ts` own turn lifecycle, cancellation,
  tool effects and recovery. Use the real JSONL store
  when claiming durability; reopen it with a new manager when claiming restart
  recovery. A transport retry is not a promise of exactly-once external effects
  across an arbitrary process crash.
- **History and assets:** `core/jsonl-thread-store.test.ts` and
  `kernel/rollout-assets.test.ts` own durable ordering, attachment bytes,
  request ownership and rollback. Use real temporary files. Cross-layer tests
  still own their RPC/transport wiring; a store round trip cannot replace them.
- **Provider and account boundaries:** `runtime/provider-registry.test.ts`,
  provider-specific suites, `runtime/provider-content.test.ts` and
  `server/chatgpt-*.test.ts` own routing, wire data, continuation scope,
  credential isolation and login/refresh races. Fake remote responses, not the
  registry, serializer, credential store or authorization boundary under test.
- **Renderer state:** `gui-state/` owns store transitions, admission/retry,
  stale stream isolation and persisted selections in Node. Its narrow harness
  supplies Storage and a URL, with no window or document. Pure renderer helpers
  remaining under `gui/*.test.ts` also run in Node.
- **Renderer interactions:** `gui/*.test.tsx` and browser notifications own
  component wiring, IME, paste, selection, Undo, asynchronous attachment
  insertion, focus and modal lifecycle. Keep these interactions where the real
  editor/component runs; moving state tests does not make these redundant.
- **Real browser/desktop wiring:** `smoke/` owns loaded-image layout, downloads,
  actual browser input and packaged Electron/sidecar wiring. Keep a small set of
  end-to-end flows rather than repeating every model/state permutation here.

## Running and interpreting checks

- For routine local changes, run `pnpm lint`, `pnpm typecheck`, and
  `pnpm test <path>` for affected Vitest files.
- For renderer or browser interaction changes, run only the affected spec with
  `pnpm test:browser <spec>`. This runs headless Chromium against built bundles.
- Run `pnpm test:desktop-smoke`, `pnpm package`, `pnpm test:computer`,
  `pnpm test:computer:live`, or `pnpm test:computer:web` locally only when the
  user explicitly requests local acceptance. The `macos-latest` Desktop
  workflow handles packaging, archive/restore, Electron smoke, and native
  Computer contracts. The separate live and web Computer acceptance suites
  require macOS Accessibility and Screen Recording grants.

- `pnpm test:contracts`: Node contracts, including real filesystem, process and
  localhost integration tests. This is not a claim that every test is a unit
  test or that a remote provider accepted the request.
- `pnpm test:ui`: happy-dom component/event checks. This is not browser layout
  or packaged desktop verification.
- `pnpm test`: both disjoint Vitest projects, once per file.
- `pnpm test:browser`: full headless Chromium smoke suite, run by CI.
- `pnpm test:desktop-smoke`: serial packaged macOS Electron smoke.
  Local smoke starts the app in the background by default. Set
  `YAKITORI_TEST_BACKGROUND=0` for explicit foreground focus acceptance.
- `pnpm check`, `pnpm build`: aggregate local checks
  and both production bundles.

Every PR runs both Vitest lanes, Chromium, and packaged macOS verification. The
`macos-latest` Desktop workflow also runs the macOS-only Computer panel spec in
headless Chromium. The `CI required` job requires every lane to succeed.
Automatic test retries are disabled. Report OS-conditional tests as skipped on
the affected OS.

Vitest gives each file a temporary home inherited by child processes, clears
provider credentials and rejects non-loopback socket connections. Account tests
use generated/fixture credentials and local endpoints. These checks do not call
paid models or establish live provider compatibility or model quality. Such a
check needs separate explicit authorization, cost bounds and result reporting.

## Changing coverage

Before adding or replacing a case, name the observable loss it prevents and
which boundary owns it. Use literal protocol expectations, independently made
fixtures, disk contents, terminal state or visible behavior. Distinguish fake
transports and media pages so that swapping them fails. A label change is not
proof of zoom, and retaining a draft is not proof that submission happened.

For critical replacements, temporarily break the claimed behavior and run the
focused test. Record the mutation and failed assertion in the PR, restore the
implementation, then rerun. Mutations are evidence for those specific faults,
not a coverage percentage or a substitute for review. Keep assertions outside
callbacks whose exceptions the runtime may legitimately catch; capture their
observations and assert after completion.

Coordinate races with explicit start/completion barriers. Poll observable
cross-process state with `expect.poll`, using the shared bounded timeout. Do not
use arbitrary sleeps, or a one-second mock polling default, as proof that a
process or persistence operation has finished. Release blocked fixtures in
`finally` so a useful assertion failure cannot deadlock cleanup.

Delete a case only when the same boundary and failure mode have equal-or-stronger
surviving coverage, or the requirement was removed. Record that destination in
the PR. Consolidate repeated setup and parameterize equivalent boundaries;
preserve distinct paths, attachment detail/order, account ownership, permissions,
capacity limits and concurrency cases. Test count is an inventory, not the goal.
