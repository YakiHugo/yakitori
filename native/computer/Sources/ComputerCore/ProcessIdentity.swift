import AppKit
import DisplayBridge

func processLaunchDate(_ pid: pid_t) -> Date? {
    guard pid > 0 else { return nil }
    // LaunchServices omits launchDate for apps started directly (including
    // Electron). Kernel birth time remains stable for that process incarnation
    // and prevents both PID reuse and repeatedly resetting Chromium's delayed
    // accessibility-provider activation. Prefer it for every identity boundary.
    let started = YKProcessStartTime(pid)
    if started > 0 { return Date(timeIntervalSince1970: started) }
    return NSRunningApplication(processIdentifier: pid)?.launchDate
}
