import { expect, type Page, test } from "@playwright/test"
import {
  clearBrowserFiles,
  inspectBrowserFiles,
} from "../../src/desktop/browser-files.ts"

test.beforeEach(async ({ page }) => {
  await page.setContent('<input type="file" multiple>')
  await page.evaluate(() => {
    const input = document.querySelector("input")
    if (!input) throw new Error("Missing test file input")
    Reflect.set(globalThis, "fileFixtureControl", input)
    const data = new DataTransfer()
    data.items.add(
      new File(["hello"], "hello.txt", { lastModified: 1700000000000 }),
    )
    input.files = data.files
    const events: { type: string; trusted: boolean; count: number }[] = []
    Reflect.set(globalThis, "fileFixtureEvents", events)
    for (const type of ["input", "change"])
      input.addEventListener(type, (event) =>
        events.push({
          type,
          trusted: event.isTrusted,
          count: input.files?.length ?? -1,
        }),
      )
  })
})

async function inspect(page: Page, readFiles: boolean) {
  return page.evaluate(
    ({ source, readFiles }) => {
      const inspect = new Function(
        `return (${source})`,
      )() as typeof inspectBrowserFiles
      return inspect.call(
        Reflect.get(globalThis, "fileFixtureControl") as HTMLInputElement,
        readFiles,
      )
    },
    { source: inspectBrowserFiles.toString(), readFiles },
  )
}
async function clear(page: Page) {
  return page.evaluate((source) => {
    const clear = new Function(
      `return (${source})`,
    )() as typeof clearBrowserFiles
    return clear.call(
      Reflect.get(globalThis, "fileFixtureControl") as HTMLInputElement,
    )
  }, clearBrowserFiles.toString())
}

test("file inspection reads native metadata without requiring focus or firing selection events", async ({
  page,
}) => {
  expect(await inspect(page, false)).toEqual({
    ok: true,
    multiple: true,
    directory: false,
  })
  expect(await inspect(page, true)).toEqual({
    ok: true,
    files: [
      {
        name: "hello.txt",
        size: 5,
        lastModified: 1700000000000,
        relativePath: "",
      },
    ],
  })
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "fileFixtureEvents")),
  ).toEqual([])
})

test("explicit clearing empties a hidden file input and emits synthetic input before change", async ({
  page,
}) => {
  await page.evaluate(() => {
    ;(
      Reflect.get(globalThis, "fileFixtureControl") as HTMLInputElement
    ).style.display = "none"
  })
  expect(await clear(page)).toEqual({ ok: true, applied: true })
  expect(await inspect(page, true)).toEqual({ ok: true, files: [] })
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "fileFixtureEvents")),
  ).toEqual([
    { type: "input", trusted: false, count: 0 },
    { type: "change", trusted: false, count: 0 },
  ])
})

for (const kind of ["disabled", "detached", "type"])
  test(`file actions refuse a ${kind} control without selection events`, async ({
    page,
  }) => {
    await page.evaluate((kind) => {
      const input = Reflect.get(
        globalThis,
        "fileFixtureControl",
      ) as HTMLInputElement
      if (kind === "disabled") input.disabled = true
      if (kind === "detached") input.remove()
      if (kind === "type") input.type = "text"
    }, kind)
    expect(await inspect(page, false)).toMatchObject({ ok: false })
    expect(await clear(page)).toEqual({ ok: false, applied: false })
    expect(
      await page.evaluate(() => Reflect.get(globalThis, "fileFixtureEvents")),
    ).toEqual([])
  })

test("clearing reports uncertainty when its input handler replaces the exact control", async ({
  page,
}) => {
  await page.evaluate(() => {
    const input = Reflect.get(
      globalThis,
      "fileFixtureControl",
    ) as HTMLInputElement
    input.addEventListener("input", () =>
      input.replaceWith(document.createElement("input")),
    )
  })
  expect(await clear(page)).toEqual({ ok: false, applied: true })
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "fileFixtureEvents")),
  ).toEqual([{ type: "input", trusted: false, count: 0 }])
})

test("file metadata refuses oversized lists and names before producing an unbounded protocol result", async ({
  page,
}) => {
  for (const kind of ["count", "name"]) {
    await page.evaluate((kind) => {
      const data = new DataTransfer()
      for (let index = 0; index < (kind === "count" ? 257 : 1); index++)
        data.items.add(
          new File(["x"], kind === "name" ? "x".repeat(65536) : `${index}.txt`),
        )
      ;(
        Reflect.get(globalThis, "fileFixtureControl") as HTMLInputElement
      ).files = data.files
    }, kind)
    expect(await inspect(page, true)).toMatchObject({ ok: false })
  }
})
