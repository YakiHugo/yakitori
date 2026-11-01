import Foundation
import DisplayBridge

func processLaunchDate(_ pid: pid_t) -> Date? {
    guard pid > 0 else { return nil }
    // Identity must have one source across discovery, input and recovery.
    // LaunchServices dates are application metadata, not an interchangeable
    // fallback for kernel process birth time. Unknown identity stays unknown.
    let started = YKProcessStartTime(pid)
    return started > 0 ? Date(timeIntervalSince1970: started) : nil
}
