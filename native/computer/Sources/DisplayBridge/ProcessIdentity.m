#include "DisplayBridge.h"
#include <libproc.h>
#include <sys/proc_info.h>

double YKProcessStartTime(int32_t pid) {
    struct proc_bsdinfo info = {0};
    if (pid <= 0 || proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info) || info.pbi_start_tvsec == 0) return 0;
    return (double)info.pbi_start_tvsec + (double)info.pbi_start_tvusec / 1000000.0;
}
