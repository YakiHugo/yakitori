// Unit iterator fixtures still expose the SDK's request/response envelope.
// HTTP and serialization contracts use real SDK clients against local servers.
export function withSDKResponse<T extends object>(client: T): T {
  for (const name of ["responses", "messages"]) {
    const resource = (client as Record<string, unknown>)[name]
    if (
      typeof resource !== "object" ||
      resource === null ||
      !("create" in resource) ||
      typeof resource.create !== "function"
    )
      continue
    const create = resource.create as (...args: unknown[]) => unknown
    resource.create = (...args: unknown[]) => {
      const pending = Promise.resolve().then(() => create.apply(resource, args))
      return Object.assign(pending, {
        withResponse: async () => ({
          data: await pending,
          response: new Response(),
        }),
      })
    }
  }
  return client
}
