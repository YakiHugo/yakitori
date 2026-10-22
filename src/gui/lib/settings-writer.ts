// Navigation flushes edits waiting for the input-coalescing timer. Writes stay
// serialized even after the settings surface that started them has closed.
export function createSettingsWriter<T>(input: {
  write(value: T): Promise<void>
  changed(state: Readonly<{ pending: boolean; error?: string }>): void
}) {
  let queued: { value: T } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<boolean> | undefined
  let failed = false
  const clearTimer = () => {
    clearTimeout(timer)
    timer = undefined
  }
  const flush = (): Promise<boolean> => {
    clearTimer()
    if (running) return running
    failed = false
    running = (async () => {
      while (queued) {
        const next = queued
        queued = undefined
        try {
          await input.write(next.value)
        } catch (cause) {
          queued ??= next
          failed = true
          clearTimer()
          input.changed({
            pending: false,
            error:
              cause instanceof Error
                ? cause.message
                : "Could not apply changes.",
          })
          return false
        }
        clearTimer()
      }
      input.changed({ pending: false })
      return true
    })().finally(() => {
      running = undefined
    })
    return running
  }
  return {
    update(value: T) {
      queued = { value }
      failed = false
      input.changed({ pending: true })
      clearTimer()
      // Avoid persisting partial API keys or rebuilding connections on each
      // keystroke. The control itself always reflects the edit immediately.
      timer = setTimeout(() => void flush(), 250)
    },
    flush,
    discardQueued() {
      clearTimer()
      queued = undefined
    },
    pending: () => !failed && (queued !== undefined || running !== undefined),
    failed: () => failed,
  }
}
