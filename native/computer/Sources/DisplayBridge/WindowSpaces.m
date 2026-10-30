#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <dlfcn.h>
#import "DisplayBridge.h"

// Optional WindowServer ABI, scoped to restoring our own isolation journals.
// The bridged operation uses the caller's AX grant; no Dock injection is used.
@interface NSObject (YakitoriSpaceSPI)
- (id)initWithWindows:(NSArray *)windows spaceID:(uint64_t)space;
- (void)performWithWMBridgeDelegate;
@end

static int (*connection)(void);
static CFArrayRef (*copySpaces)(int, int, CFArrayRef);
static uint64_t (*displaySpace)(int, CFStringRef);

static void loadSpaces(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        void *library = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY | RTLD_LOCAL);
        if (!library) return;
        connection = dlsym(library, "SLSMainConnectionID");
        copySpaces = dlsym(library, "SLSCopySpacesForWindows");
        displaySpace = dlsym(library, "SLSManagedDisplayGetCurrentSpace");
    });
}

bool YKWindowSpacesSupported(void) {
    loadSpaces();
    Class operation = NSClassFromString(@"SLSBridgedMoveWindowsToManagedSpaceOperation");
    return connection && copySpaces && displaySpace &&
        [operation instancesRespondToSelector:@selector(initWithWindows:spaceID:)] &&
        [operation instancesRespondToSelector:@selector(performWithWMBridgeDelegate)];
}

uint64_t YKWindowSpace(uint32_t window) {
    loadSpaces();
    if (!connection || !copySpaces) return 0;
    NSArray *spaces = CFBridgingRelease(copySpaces(connection(), 7, (__bridge CFArrayRef)@[@(window)]));
    if (![spaces isKindOfClass:NSArray.class] || spaces.count != 1 ||
        CFGetTypeID((__bridge CFTypeRef)spaces.firstObject) != CFNumberGetTypeID()) return 0;
    return [spaces.firstObject unsignedLongLongValue];
}

uint64_t YKDisplaySpace(uint32_t display) {
    loadSpaces();
    if (!connection || !displaySpace) return 0;
    CFUUIDRef uuid = CGDisplayCreateUUIDFromDisplayID(display);
    if (!uuid) return 0;
    CFStringRef name = CFUUIDCreateString(kCFAllocatorDefault, uuid);
    uint64_t space = displaySpace(connection(), name);
    CFRelease(name); CFRelease(uuid);
    return space;
}

bool YKRestoreWindowSpace(uint32_t window, uint64_t space) {
    if (!YKWindowSpacesSupported() || !space) return false;
    id operation = [[NSClassFromString(@"SLSBridgedMoveWindowsToManagedSpaceOperation") alloc]
        initWithWindows:@[@(window)] spaceID:space];
    if (!operation) return false;
    [operation performWithWMBridgeDelegate];
    // Submission is not proof of movement. The caller checks membership/AX.
    return true;
}
