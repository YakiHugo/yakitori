import { expect, it } from "vitest"
import { BrowserPendingMutations } from "../../src/desktop/browser-mutations.ts"

it("owns disconnected mutations until positive acknowledgement, including late replies", async () => {
  const owner = new BrowserPendingMutations(() => false),
    scope = new AbortController(),
    started = Promise.withResolvers<void>(),
    reply = Promise.withResolvers<unknown>()
  const operation = owner.run(() => {
    started.resolve()
    return reply.promise
  }, scope.signal)
  const failed = expect(operation).rejects.toMatchObject({
    code: "browser_input_unconfirmed",
  })
  await started.promise
  scope.abort()
  await failed
  expect(() => owner.assertCompleted()).toThrow(/no confirmed completion/)
  reply.resolve({})
  await expect.poll(() => owner.assertCompleted()).toBeUndefined()
})

it("retains transport uncertainty after a disconnected command rejects until its target is destroyed", async () => {
  let destroyed = false
  const owner = new BrowserPendingMutations(() => destroyed),
    scope = new AbortController(),
    started = Promise.withResolvers<void>(),
    reply = Promise.withResolvers<unknown>()
  const operation = owner.run(() => {
    started.resolve()
    return reply.promise
  }, scope.signal)
  const failed = expect(operation).rejects.toMatchObject({
    code: "browser_input_unconfirmed",
  })
  await started.promise
  scope.abort()
  await failed
  reply.reject(new Error("Transport gone"))
  await reply.promise.catch(() => {})
  expect(() => owner.assertCompleted()).toThrow(/no confirmed completion/)
  destroyed = true
  owner.assertCompleted()
})

it("allows cleanup after an ordinary command error from a live original session", async () => {
  const owner = new BrowserPendingMutations(() => false)
  await expect(
    owner.run(async () => {
      throw new Error("Node is no longer focusable")
    }, new AbortController().signal),
  ).rejects.toThrow("Node is no longer focusable")
  owner.assertCompleted()
})

it("does not treat an async effect's failed observation as proof that its mutation stopped", async () => {
  let destroyed = false
  const owner = new BrowserPendingMutations(() => destroyed)
  await expect(
    owner.run(
      async () => {
        throw new Error("Directory completion context disappeared")
      },
      new AbortController().signal,
      "effect",
    ),
  ).rejects.toThrow("completion context disappeared")
  expect(() => owner.assertCompleted()).toThrow(/no confirmed completion/)
  destroyed = true
  owner.assertCompleted()
})

it("does not dispatch or retain a mutation if its original session closes before dispatch", async () => {
  const owner = new BrowserPendingMutations(() => false),
    scope = new AbortController()
  let calls = 0
  const operation = owner.run(async () => ++calls, scope.signal)
  const failed = expect(operation).rejects.toBeDefined()
  scope.abort()
  await failed
  expect(calls).toBe(0)
  owner.assertCompleted()
})
