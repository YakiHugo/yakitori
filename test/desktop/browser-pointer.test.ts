import { expect, it } from "vitest"
import type {
  BrowserFrameBinding,
  BrowserProtocolCommand,
} from "../../src/desktop/browser-frames.ts"
import { BrowserFramePointer } from "../../src/desktop/browser-pointer.ts"

function frame(
  id: string,
  parentId?: string,
  sessionId?: string,
): BrowserFrameBinding {
  return {
    document: {
      frameId: id,
      documentId: `${id}_v1`,
      url: `https://owned.test/${id}`,
    },
    name: id,
    ...(parentId ? { parentId } : {}),
    ...(sessionId ? { sessionId } : {}),
  }
}

function fixture(path: BrowserFrameBinding[], quads: Record<string, number[]>) {
  const calls: {
    method: string
    sessionId: string | undefined
    frameId?: string
    point?: unknown
  }[] = []
  const worlds = new Map<string, number>(),
    nodes = new Map<number, string>(),
    objects = new Map<string, string>()
  let covered = ""
  const command: BrowserProtocolCommand = async (
    method,
    params = {},
    sessionId,
  ) => {
    const call: (typeof calls)[number] = { method, sessionId }
    calls.push(call)
    if (method === "Page.createIsolatedWorld") {
      const id = String(params.frameId),
        context = worlds.size + 1
      worlds.set(id, context)
      return { executionContextId: context }
    }
    if (method === "DOM.getFrameOwner") {
      const id = String(params.frameId),
        node = nodes.size + 1
      nodes.set(node, id)
      call.frameId = id
      return { backendNodeId: node }
    }
    if (method === "DOM.resolveNode") {
      const id = nodes.get(Number(params.backendNodeId))
      if (!id) throw new Error("Unknown frame owner")
      objects.set(`owner_${id}`, id)
      return { object: { objectId: `owner_${id}` } }
    }
    if (method === "DOM.getBoxModel") {
      const id = nodes.get(Number(params.backendNodeId))
      if (!id || !quads[id]) throw new Error("Unknown content quad")
      call.frameId = id
      return { model: { content: quads[id] } }
    }
    if (method === "Runtime.evaluate")
      return { result: { value: { width: 100, height: 100 } } }
    if (method === "Runtime.callFunctionOn") {
      const id = objects.get(String(params.objectId))
      if (!id) throw new Error("Unknown frame object")
      call.frameId = id
      const args = params.arguments as { value: unknown }[]
      call.point = args[1]?.value
      return { result: { value: { ok: covered !== id } } }
    }
    throw new Error(`Unexpected pointer command ${method}`)
  }
  const pointer = new BrowserFramePointer(path, command, command, "owned_group")
  return {
    pointer,
    calls,
    cover: (id: string) => {
      covered = id
    },
  }
}

it.each([
  {
    name: "scale and translation",
    quad: [100, 100, 300, 100, 300, 300, 100, 300],
    point: { x: 140, y: 160 },
  },
  {
    name: "rotation",
    quad: [200, 100, 200, 300, 0, 300, 0, 100],
    point: { x: 140, y: 140 },
  },
  {
    name: "reflection",
    quad: [300, 100, 100, 100, 100, 300, 300, 300],
    point: { x: 260, y: 160 },
  },
  {
    name: "perspective",
    quad: [0, 0, 100, 0, 200 / 3, 200 / 3, 0, 200 / 3],
    point: { x: 17.391304347826, y: 26.086956521739 },
  },
])("maps frame-local CSS coordinates through $name", async ({
  quad,
  point,
}) => {
  const f = fixture([frame("main"), frame("child", "main")], { child: quad })
  await f.pointer.prepare()
  const projected = await f.pointer.project({ x: 20, y: 30 })
  expect(projected.x).toBeCloseTo(point.x, 8)
  expect(projected.y).toBeCloseTo(point.y, 8)
  expect(f.calls.find((call) => call.point)).toMatchObject({ point: projected })
})

it("composes nested OOPIF coordinates from each owning session viewport and hit-tests every parent in its own local coordinates", async () => {
  const f = fixture(
    [
      frame("main"),
      frame("local", "main"),
      frame("remote", "local", "remote_session"),
      frame("leaf", "remote", "leaf_session"),
    ],
    {
      local: [100, 100, 300, 100, 300, 300, 100, 300],
      remote: [140, 160, 240, 160, 240, 260, 140, 260],
      leaf: [10, 20, 110, 20, 110, 120, 10, 120],
    },
  )
  await f.pointer.prepare()
  expect(await f.pointer.project({ x: 20, y: 30 })).toEqual({ x: 170, y: 210 })
  expect(
    f.calls
      .filter((call) => call.method === "DOM.getFrameOwner")
      .map((call) => ({ frame: call.frameId, session: call.sessionId })),
  ).toEqual([
    { frame: "local", session: undefined },
    { frame: "remote", session: undefined },
    { frame: "leaf", session: "remote_session" },
  ])
  expect(
    f.calls
      .filter((call) => call.point)
      .map((call) => ({ frame: call.frameId, point: call.point })),
  ).toEqual([
    { frame: "local", point: { x: 170, y: 210 } },
    { frame: "remote", point: { x: 35, y: 55 } },
    { frame: "leaf", point: { x: 30, y: 50 } },
  ])
  expect([...f.pointer.sessions]).toEqual([undefined, "remote_session"])
})

it("refuses a covered ancestor and a singular or folded content quad", async () => {
  for (const quad of [
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 100, 100, 100, 0, 0, 100],
  ]) {
    const f = fixture([frame("main"), frame("child", "main")], { child: quad })
    await f.pointer.prepare()
    await expect(f.pointer.project({ x: 20, y: 30 })).rejects.toMatchObject({
      code: "browser_input_unavailable",
    })
  }
  const f = fixture([frame("main"), frame("child", "main")], {
    child: [0, 0, 100, 0, 100, 100, 0, 100],
  })
  await f.pointer.prepare()
  f.cover("child")
  await expect(f.pointer.project({ x: 20, y: 30 })).rejects.toMatchObject({
    code: "browser_input_unavailable",
  })
})

it("refuses parent document or renderer replacement even if the leaf binding survives", () => {
  const path = [frame("main"), frame("parent", "main"), frame("leaf", "parent")]
  const f = fixture(path, {})
  f.pointer.verifyPath(path)
  for (const parent of [
    {
      ...frame("parent", "main"),
      document: { ...frame("parent").document, documentId: "replacement" },
    },
    frame("parent", "main", "replacement_session"),
  ])
    expect(() =>
      f.pointer.verifyPath([frame("main"), parent, frame("leaf", "parent")]),
    ).toThrow("A parent frame changed")
})
