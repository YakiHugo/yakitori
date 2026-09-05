// The HTTP API client is gone: the GUI speaks JSON-RPC over /rpc (see
// rpc-client.ts). This module keeps only the URL helper for the remaining
// plain-HTTP surface (rollout asset downloads).
export function apiUrl(apiBase: string, path: string): string {
  const base = apiBase.endsWith("/") ? apiBase : `${apiBase}/`
  return new URL(path.replace(/^\//, ""), base).toString()
}
