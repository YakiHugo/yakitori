export type BrowserProtocolCommand = (
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) => Promise<unknown>
const frameReadMethods = [
  "Page.getFrameTree",
  "Page.createIsolatedWorld",
  "DOM.resolveNode",
  "DOM.getFrameOwner",
  "DOM.getBoxModel",
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
  "Accessibility.getFullAXTree",
] as const
export type BrowserFrameReadMethod = (typeof frameReadMethods)[number]
export function isBrowserFrameReadMethod(
  method: string,
): method is BrowserFrameReadMethod {
  return frameReadMethods.some((value) => value === method)
}
export type BrowserFrameReadCommand = (
  method: BrowserFrameReadMethod,
  params?: Record<string, unknown>,
  sessionId?: string,
) => Promise<unknown>
