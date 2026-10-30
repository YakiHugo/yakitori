# macOS computer execution

The harness owns planning and tool execution. This helper owns native observation,
input, and the lifetime of its observations. It has no model or agent loop.
LaunchServices starts the signed app so macOS permission grants belong to
`com.yakitori.computer`, independently of the Node/Electron host. Each MCP
connection owns one app process; EOF, parent death, and cancellation drain its
active input before release.

Background events use public per-process CGEvents. Some applications ignore these
events or consult the physical cursor instead; delivery is explicitly unverified.
There is no automatic foreground retry. Observation targets the current desktop's
visible windows or an explicitly selected display. Screen pixel input requires
foreground delivery; window/app inputs keep an exact owning window even when
their observation combines several windows. Background typing requires confirmed
AX focus. This does not establish support for every macOS application, other
Spaces, capture of minimized windows, locked desktops, or arbitrary canvas keyboard input.

The Wuu reference was inspected at
`2903ea990580a92e53215781cd99a821c5df80f3` (2026-10-17), including its native
input/capture, focus, virtual-display and process contracts. Launch resolution and
observation changes also inspected `7d58d83d75d418b4d33802085d6482a6cf8ea1e9`
(2026-10-21); these local snapshots do not establish current upstream behavior. Implementation here
uses Apple frameworks directly, with no dependency on reference checkouts or
Cua Driver. Directed pointer events encode an AppKit window identity as well as
Quartz hit-test fields: the latter alone leave `NSEvent.windowNumber` at zero.
PID-directed pointer input also requires the optional macOS
`CGEventSetWindowLocation` SPI to populate AppKit's separate local coordinates.
If unavailable, the helper refuses background pointer input before button-down;
foreground delivery must be explicitly requested. Directed AppKit activation is
scoped to one action and restored on completion/cancellation, without suppressing
user activation events or bringing the application onto the shared foreground.

Stored AX trees and input tickets have separate lifetimes: querying cached evidence
does not renew permission to act on it. Cross-process application revisions invalidate
older observations after another helper mutates the same app. Native resource locks
serialize application mutations, the shared foreground, and clipboard ownership across
MCP connections. Exact selectors refuse clipped attributes or incomplete trees when
uniqueness cannot be established. App menus carry an anchor window identity rather
than falsely claiming to be descendants of that window.

The native sequence is a bounded, caller-fixed batch of AX/keyboard operations in
one process incarnation. It has no branches, planning, input retries, or target
switching. Each step resolves fresh AX state; cancellation drains held input and
reports completed steps. Task orchestration remains in the harness.

Optional virtual-display SPI is isolated behind `DisplayBridge`. A detached helper
owns that display, independently of an MCP process. Concealment journals restoration
intent before moving windows, holds an application lease, and restores on turn end
or disconnect. The service recovers abandoned leases after helper crashes. If the
display service itself dies, WindowServer rescues window geometry but can assign
windows to a different desktop. The journal also records original desktop membership;
recovery restores that membership before resolving AX identity, while respecting
subsequent user movement. Unsupported SPI fails explicitly before concealment.
An empty display lease is cached for the MCP connection after turn cleanup;
explicit reveal or disconnect releases it. This avoids repeated host-display
reconfiguration between rapid turns. Completed window intent is retained until
the display has been explicitly removed and its service has reconciled the final
WindowServer reassignment, because correct AX restoration can precede that event.
Restoration waits within a shared two-second read-only identity budget during
display transitions. It re-exposes exact formerly visible windows that macOS left
unordered, and retains unresolved records with a concrete reason. Cleanup is
awaited before helper exit; it does not replay a failed window mutation.
The virtual backing store and batch/wait/input bounds are local allocation and
execution safety boundaries, not model or product quotas.

The optional desktop bridge was checked against DockDoor's native selectors at
`3044142c907b9cdd49917628847a04970450a8e6` (inspected 2026-10-30), in
[`PrivateApis.swift`](https://github.com/ejbills/DockDoor/blob/3044142c907b9cdd49917628847a04970450a8e6/DockDoor/Utilities/PrivateApis.swift).
This is a narrow recovery mechanism, not general desktop switching or a runtime
dependency on that project.

`pnpm test:computer` checks native coordinate/identity/cancellation contracts and
the real signed app's LaunchServices/MCP lifecycle without requesting access.
`pnpm test:computer:live` runs an owned AppKit fixture. The cases verify actual
PNG geometry, AX button effects, stale/moved/closed observation rejection,
Unicode input into two fields, replacement, foreground pixel input, and native
cancellation of drag and typing. Assertions read the fixture's application state,
not the driver's delivery claim. No existing user document is operated.

During development, run only the affected group or independently prepared case:

```sh
pnpm build:computer
pnpm test:computer:live --group capabilities --case 'window management'
pnpm test:computer:live --group isolation
```

Groups are `base`, `capabilities`, and `isolation`; the default `all` is the final
acceptance run. Base cases intentionally share a sequential state contract and do
not accept a case filter. Other cases prepare their own prerequisites. Unmatched
filters fail, and reports identify the group/filter and actually executed cases.
Even an `all` run creates a fresh fixture for each group, so focused and complete
runs have the same starting state. Groups run serially because native foreground
input and display configuration are shared host resources.
The fixture is launched as an owned app through LaunchServices so process launch
identity is real. Its executable is reused only when source, compiler, SDK, and
architecture match. A live run uses the already-built helper and never rebuilds it.

`pnpm bench:computer` repeats those cases five times and writes raw case durations,
median/p95 summaries, OS/build identity and permission status to
`test-results/computer-bench.json`. This is a scripted driver microbenchmark,
not an agent/model benchmark or a score comparable with OSWorld. Missing macOS
permissions produce a blocked report with zero executed cases and a failing exit
status; they are never counted as passed cases. Both commands require enabling
Accessibility and Screen Recording for **Yakitori Computer** in System Settings.
