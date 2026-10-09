export function createRequestId(): string {
  return `request_${globalThis.crypto.randomUUID()}`
}

export function isRequestId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}
