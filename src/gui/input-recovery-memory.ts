// Composer submissions survive session switches and connection retries while
// this renderer is alive. No draft or steer snapshot is written to browser
// storage before the server accepts it.
const entries = new Map<string, string>()

export const inputRecoveryMemory = {
  get length() { return entries.size },
  key(index: number): string | null { return [...entries.keys()][index] ?? null },
  getItem(key: string): string | null { return entries.get(key) ?? null },
  setItem(key: string, value: string): void { entries.set(key, value) },
  removeItem(key: string): void { entries.delete(key) },
  clear(): void { entries.clear() },
}
