#pragma once
#include <stdbool.h>
#include <stdint.h>

bool YKDisplaySupported(void);
void *YKDisplayCreate(uint32_t width, uint32_t height);
uint32_t YKDisplayIdentifier(void *display);
void YKDisplayDestroy(void *display);
int YKStartDisplayService(const char *executable, const char *directory);
bool YKWindowSpacesSupported(void);
uint64_t YKWindowSpace(uint32_t window);
uint64_t YKDisplaySpace(uint32_t display);
bool YKRestoreWindowSpace(uint32_t window, uint64_t space);
double YKProcessStartTime(int32_t pid);
