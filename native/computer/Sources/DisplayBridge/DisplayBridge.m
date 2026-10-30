#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <spawn.h>
#import <fcntl.h>
#import <unistd.h>
#import "DisplayBridge.h"

// These optional WindowServer interfaces have no public SDK declarations.
// Resolve classes at runtime and keep their ownership behind this C boundary.
@interface NSObject (YakitoriDisplaySPI)
- (id)initWithDescriptor:(id)descriptor;
- (id)initWithWidth:(unsigned int)width height:(unsigned int)height refreshRate:(double)rate;
- (BOOL)applySettings:(id)settings;
- (CGDirectDisplayID)displayID;
@end

bool YKDisplaySupported(void) {
    for (NSString *name in @[@"CGVirtualDisplay", @"CGVirtualDisplayDescriptor", @"CGVirtualDisplayMode", @"CGVirtualDisplaySettings"])
        if (!NSClassFromString(name)) return false;
    return [NSClassFromString(@"CGVirtualDisplay") instancesRespondToSelector:@selector(initWithDescriptor:)] &&
        [NSClassFromString(@"CGVirtualDisplay") instancesRespondToSelector:@selector(applySettings:)] &&
        [NSClassFromString(@"CGVirtualDisplayMode") instancesRespondToSelector:@selector(initWithWidth:height:refreshRate:)];
}

void *YKDisplayCreate(uint32_t width, uint32_t height) {
    if (!YKDisplaySupported() || !width || !height) return NULL;
    id descriptor = [[NSClassFromString(@"CGVirtualDisplayDescriptor") alloc] init];
    NSDictionary *fields = @{@"queue": dispatch_get_main_queue(), @"name": @"Yakitori Agent Display",
        @"maxPixelsWide": @(width), @"maxPixelsHigh": @(height),
        @"sizeInMillimeters": [NSValue valueWithSize:NSMakeSize(width * 25.4 / 110, height * 25.4 / 110)],
        @"vendorID": @0x796b, @"productID": @0x4355, @"serialNum": @1,
        @"terminationHandler": ^(id display, id reason) { (void)display; (void)reason; }};
    for (NSString *key in fields) {
        NSString *setter = [NSString stringWithFormat:@"set%@%@:", [[key substringToIndex:1] uppercaseString], [key substringFromIndex:1]];
        if (![descriptor respondsToSelector:NSSelectorFromString(setter)]) return NULL;
        [descriptor setValue:fields[key] forKey:key];
    }
    id display = [[NSClassFromString(@"CGVirtualDisplay") alloc] initWithDescriptor:descriptor];
    if (!display) return NULL;
    id settings = [[NSClassFromString(@"CGVirtualDisplaySettings") alloc] init];
    if (![settings respondsToSelector:@selector(setValue:forKey:)] ||
        ![settings respondsToSelector:NSSelectorFromString(@"setModes:")] ||
        ![settings respondsToSelector:NSSelectorFromString(@"setHiDPI:")]) return NULL;
    id mode = [[NSClassFromString(@"CGVirtualDisplayMode") alloc] initWithWidth:width height:height refreshRate:60];
    if (!mode) return NULL;
    [settings setValue:@[mode] forKey:@"modes"];
    [settings setValue:@0 forKey:@"hiDPI"];
    if (![display applySettings:settings]) return NULL;
    return (__bridge_retained void *)display;
}

uint32_t YKDisplayIdentifier(void *display) { return [(__bridge id)display displayID]; }
void YKDisplayDestroy(void *display) { if (display) { id owner = (__bridge_transfer id)display; (void)owner; } }

int YKStartDisplayService(const char *executable, const char *directory) {
    posix_spawnattr_t attributes;
    posix_spawn_file_actions_t actions;
    int error = posix_spawnattr_init(&attributes);
    if (error) return -error;
    error = posix_spawn_file_actions_init(&actions);
    if (error) { posix_spawnattr_destroy(&attributes); return -error; }
    posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETSID | POSIX_SPAWN_CLOEXEC_DEFAULT);
    posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0);
    posix_spawn_file_actions_addopen(&actions, 1, "/dev/null", O_WRONLY, 0);
    NSString *log = [[NSString stringWithUTF8String:directory] stringByAppendingPathComponent:@"service.log"];
    posix_spawn_file_actions_addopen(&actions, 2, log.fileSystemRepresentation, O_WRONLY | O_CREAT | O_APPEND, 0600);
    char *arguments[] = {(char *)executable, "--display-service", NULL};
    extern char **environ;
    pid_t pid = 0;
    error = posix_spawn(&pid, executable, &actions, &attributes, arguments, environ);
    posix_spawn_file_actions_destroy(&actions);
    posix_spawnattr_destroy(&attributes);
    return error ? -error : pid;
}
