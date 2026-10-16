# macOS computer execution

The harness owns planning and tool execution. This helper owns native observation,
input, and the lifetime of its observations. It has no model or agent loop.
LaunchServices starts the signed app so macOS permission grants belong to
`com.yakitori.computer`, independently of the Node/Electron host. Each MCP
connection owns one app process; EOF, parent death, and cancellation drain its
active input before release.

Background events use public per-process CGEvents. Some applications ignore these
events or consult the physical cursor instead; delivery is explicitly unverified.
There is no automatic foreground retry. Current observation targets visible
windows on the current desktop, and background typing requires confirmed AX
focus. This does not yet establish support for every macOS application, other
Spaces, minimized windows, locked desktops, or arbitrary canvas keyboard input.

The local Wuu reference was inspected at
`2bab386ca0d3ee9beb49cef72275fdf73d0c83de` (2026-10-15), specifically its
native input/capture and process contracts. That snapshot predates upstream
changes discussed in research. Implementation here is independent, uses Apple
frameworks directly, and has no dependency on reference checkouts or Cua Driver.

`pnpm test:computer` checks native coordinate/identity/cancellation contracts and
the real signed app's LaunchServices/MCP lifecycle without requesting access.
`pnpm test:computer:live` runs an owned AppKit fixture. The cases verify actual
PNG geometry, AX button effects, stale/moved/closed observation rejection,
Unicode input into two fields, replacement, foreground pixel input, and native
cancellation of drag and typing. Assertions read the fixture's application state,
not the driver's delivery claim. No existing user document is operated.

`pnpm bench:computer` repeats those cases five times and writes raw case durations,
median/p95 summaries, OS/build identity and permission status to
`test-results/computer-bench.json`. This is a scripted driver microbenchmark,
not an agent/model benchmark or a score comparable with OSWorld. Missing macOS
permissions produce a blocked report with zero executed cases and a failing exit
status; they are never counted as passed cases. Both commands require enabling
Accessibility and Screen Recording for **Yakitori Computer** in System Settings.
