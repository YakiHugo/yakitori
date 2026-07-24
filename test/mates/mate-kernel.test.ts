import { describe, expect, it } from "vitest"
import {
  createMateKernel,
  isMateId,
  isMateRevisionId,
  MateLifecycle,
  YakitoriErrorCode,
} from "../../src/index.ts"
import { createMemoryMateStore } from "./memory-mate-store.ts"

describe("mate kernel", () => {
  it("creates a durable identity with an initial immutable revision", async () => {
    const kernel = createMateKernel(createMemoryMateStore())

    const result = await kernel.createMate({
      instructions: "Keep changes small.",
      name: "Momo",
      role: "Builder",
    })

    expect(isMateId(result.mate.id)).toBe(true)
    expect(isMateRevisionId(result.mate.currentRevision.id)).toBe(true)
    expect(result.mate).toEqual({
      createdAt: result.mate.createdAt,
      currentRevision: {
        createdAt: result.mate.currentRevision.createdAt,
        id: result.mate.currentRevision.id,
        instructions: "Keep changes small.",
        name: "Momo",
        revision: 1,
        role: "Builder",
      },
      id: result.mate.id,
      lifecycle: MateLifecycle.Active,
      revisions: [result.mate.currentRevision],
      seq: 1,
      updatedAt: result.mate.updatedAt,
    })
  })

  it("adds revisions without rewriting the previous profile", async () => {
    const kernel = createMateKernel(createMemoryMateStore())
    const created = await kernel.createMate({
      instructions: "Investigate first.",
      name: "Momo",
      role: "Researcher",
    })
    const original = created.mate.currentRevision

    const revised = await kernel.reviseMate({
      instructions: "Investigate, then implement.",
      mateId: created.mate.id,
      name: "Momo",
      role: "Engineer",
    })

    expect(revised.mate.revisions).toEqual([
      original,
      revised.mate.currentRevision,
    ])
    expect(revised.mate.currentRevision).toEqual({
      createdAt: revised.mate.currentRevision.createdAt,
      id: revised.mate.currentRevision.id,
      instructions: "Investigate, then implement.",
      name: "Momo",
      revision: 2,
      role: "Engineer",
    })
    expect(original).toEqual({
      createdAt: original.createdAt,
      id: original.id,
      instructions: "Investigate first.",
      name: "Momo",
      revision: 1,
      role: "Researcher",
    })
  })

  it("serializes concurrent revisions for one mate", async () => {
    const kernel = createMateKernel(createMemoryMateStore())
    const created = await kernel.createMate({
      instructions: "Initial",
      name: "Momo",
      role: "Builder",
    })

    await Promise.all([
      kernel.reviseMate({
        instructions: "Second",
        mateId: created.mate.id,
        name: "Momo",
        role: "Builder",
      }),
      kernel.reviseMate({
        instructions: "Third",
        mateId: created.mate.id,
        name: "Momo",
        role: "Builder",
      }),
    ])

    expect((await kernel.readMate({ mateId: created.mate.id })).mate).toEqual(
      expect.objectContaining({
        currentRevision: expect.objectContaining({ revision: 3 }),
        seq: 3,
      }),
    )
  })

  it("prevents inactive mates from changing profile", async () => {
    const kernel = createMateKernel(createMemoryMateStore())
    const created = await kernel.createMate({
      instructions: "Initial",
      name: "Momo",
      role: "Builder",
    })
    const inactive = await kernel.setMateLifecycle({
      lifecycle: MateLifecycle.Inactive,
      mateId: created.mate.id,
    })

    await expect(
      kernel.reviseMate({
        instructions: "Changed",
        mateId: created.mate.id,
        name: "Momo",
        role: "Builder",
      }),
    ).rejects.toMatchObject({ code: YakitoriErrorCode.InvalidState })
    expect(inactive.mate).toEqual(
      expect.objectContaining({
        currentRevision: created.mate.currentRevision,
        lifecycle: MateLifecycle.Inactive,
        seq: 2,
      }),
    )
  })

  it("validates bounded profile fields", async () => {
    const kernel = createMateKernel(createMemoryMateStore())

    await expect(
      kernel.createMate({ instructions: "", name: " ", role: "Builder" }),
    ).rejects.toMatchObject({
      code: YakitoriErrorCode.InvalidArgument,
      details: { field: "name" },
    })
    await expect(
      kernel.createMate({
        instructions: "x".repeat(32_001),
        name: "Momo",
        role: "Builder",
      }),
    ).rejects.toMatchObject({
      code: YakitoriErrorCode.InvalidArgument,
      details: { field: "instructions" },
    })
  })

  it("lists mates through a bounded cursor", async () => {
    const kernel = createMateKernel(createMemoryMateStore())
    const created = await Promise.all([
      kernel.createMate({ instructions: "A", name: "A", role: "Builder" }),
      kernel.createMate({ instructions: "B", name: "B", role: "Builder" }),
    ])

    const first = await kernel.listMates({ limit: 1 })
    if (!first.nextCursor) throw new Error("Expected a next cursor.")
    const second = await kernel.listMates({
      cursor: first.nextCursor,
      limit: 1,
    })

    expect([...first.mates, ...second.mates].map((mate) => mate.id)).toEqual(
      expect.arrayContaining(created.map((result) => result.mate.id)),
    )
    expect(first.mates[0]).not.toHaveProperty("revisions")
    expect(second.nextCursor).toBeUndefined()
  })

  it("validates mate ids independently of the store adapter", async () => {
    const kernel = createMateKernel(createMemoryMateStore())

    await expect(
      kernel.readMate({ mateId: "../../outside" }),
    ).rejects.toMatchObject({
      code: YakitoriErrorCode.InvalidArgument,
      details: { mateId: "../../outside" },
    })
    await expect(
      kernel.listMates({ cursor: "../../outside" }),
    ).rejects.toMatchObject({
      code: YakitoriErrorCode.InvalidArgument,
      details: { mateId: "../../outside" },
    })
  })
})
