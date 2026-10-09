import type { ApiErrorResponse } from "../protocol/application.ts"

// Application failures are transport-neutral. HTTP and RPC own their envelopes.
export type ApplicationResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: ApiErrorResponse["error"] }>
