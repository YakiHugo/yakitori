import { expect, type Page, test } from "@playwright/test"
import {
  selectBrowserOptions,
  verifyBrowserSelection,
} from "../../src/desktop/browser-select.ts"
import type { BrowserSelectRequest } from "../../src/protocol/desktop-browser.ts"

test.beforeEach(async ({ page }) => {
  await page.setContent(
    '<select><option value="r">Red</option><option value="g">Green</option><option value="b">Blue</option></select>',
  )
  await page.evaluate(() => {
    const select = document.querySelector("select")
    if (!select) throw new Error("Missing test select")
    select.focus()
    Reflect.set(globalThis, "selectFixtureControl", select)
    const events: { type: string; trusted: boolean; values: string[] }[] = []
    Reflect.set(globalThis, "selectFixtureEvents", events)
    for (const type of ["input", "change"])
      select.addEventListener(type, (event) =>
        events.push({
          type,
          trusted: event.isTrusted,
          values: Array.from(select.selectedOptions, (option) => option.value),
        }),
      )
  })
})

async function choose(
  page: Page,
  options: BrowserSelectRequest["options"],
): Promise<ReturnType<typeof selectBrowserOptions>> {
  return page.evaluate(
    ({ source, options }) => {
      // Exercise the same serialization/realm boundary as Runtime.callFunctionOn,
      // using only this repository's fixed function, not page/model-provided code.
      const select = new Function(
        `return (${source})`,
      )() as typeof selectBrowserOptions
      return select.call(
        Reflect.get(globalThis, "selectFixtureControl") as HTMLSelectElement,
        options,
      )
    },
    { source: selectBrowserOptions.toString(), options },
  )
}

async function state(page: Page) {
  return page.evaluate(() => {
    const select = Reflect.get(
      globalThis,
      "selectFixtureControl",
    ) as HTMLSelectElement
    return {
      value: select.value,
      index: select.selectedIndex,
      events: Reflect.get(globalThis, "selectFixtureEvents") as {
        type: string
        trusted: boolean
        values: string[]
      }[],
    }
  })
}

for (const option of [{ value: "g" }, { label: "Green" }, { index: 1 }])
  test(`native select resolves ${JSON.stringify(option)} and emits input before change`, async ({
    page,
  }) => {
    expect(await choose(page, [option])).toEqual({
      ok: true,
      applied: true,
      values: ["g"],
    })
    expect(await state(page)).toEqual({
      value: "g",
      index: 1,
      events: [
        { type: "input", trusted: false, values: ["g"] },
        { type: "change", trusted: false, values: ["g"] },
      ],
    })
  })

test("native multiple select preserves DOM order, deduplicates identical options and clears selection", async ({
  page,
}) => {
  await page.evaluate(() => {
    ;(
      Reflect.get(globalThis, "selectFixtureControl") as HTMLSelectElement
    ).multiple = true
  })
  expect(
    await choose(page, [{ index: 2 }, { value: "r" }, { label: "Red" }]),
  ).toEqual({ ok: true, applied: true, values: ["r", "b"] })
  expect(await choose(page, [])).toEqual({
    ok: true,
    applied: true,
    values: [],
  })
  expect(await state(page)).toEqual({
    value: "",
    index: -1,
    events: [
      { type: "input", trusted: false, values: ["r", "b"] },
      { type: "change", trusted: false, values: ["r", "b"] },
      { type: "input", trusted: false, values: [] },
      { type: "change", trusted: false, values: [] },
    ],
  })
})

test("native single select refuses missing, ambiguous and multiple options without selection events, then clears", async ({
  page,
}) => {
  await page.evaluate(() => {
    ;(Reflect.get(globalThis, "selectFixtureControl") as HTMLSelectElement).add(
      new Option("Green", "another"),
    )
  })
  for (const options of [
    [{ value: "missing" }],
    [{ label: "Green" }],
    [{ index: 0 }, { index: 1 }],
  ]) {
    expect(await choose(page, options)).toMatchObject({
      ok: false,
      applied: false,
    })
    expect(await state(page)).toEqual({ value: "r", index: 0, events: [] })
  }
  expect(await choose(page, [])).toEqual({
    ok: true,
    applied: true,
    values: [],
  })
  expect((await state(page)).index).toBe(-1)
})

for (const kind of ["control", "option", "group", "focus"])
  test(`native select refuses an unavailable target or option (${kind})`, async ({
    page,
  }) => {
    await page.evaluate((kind) => {
      const select = Reflect.get(
        globalThis,
        "selectFixtureControl",
      ) as HTMLSelectElement
      if (kind === "control") select.disabled = true
      if (kind === "option") select.options[1]?.setAttribute("disabled", "")
      if (kind === "group") {
        const group = document.createElement("optgroup")
        group.disabled = true
        const option = select.options[1]
        if (!option) throw new Error("Missing test option")
        group.append(option)
        select.append(group)
      }
      if (kind === "focus") select.blur()
    }, kind)
    expect(await choose(page, [{ value: "g" }])).toMatchObject({
      ok: false,
      applied: false,
    })
    expect((await state(page)).value).toBe("r")
    expect((await state(page)).events).toEqual([])
  })

for (const kind of ["rewrite", "replace"])
  test(`native select reports applied but unconfirmed when its input handler performs ${kind}`, async ({
    page,
  }) => {
    await page.evaluate((kind) => {
      const select = Reflect.get(
        globalThis,
        "selectFixtureControl",
      ) as HTMLSelectElement
      select.addEventListener("input", () => {
        if (kind === "rewrite") select.value = "r"
        else select.replaceWith(document.createElement("select"))
      })
    }, kind)
    expect(await choose(page, [{ value: "g" }])).toMatchObject({
      ok: false,
      applied: true,
    })
    expect((await state(page)).events.map((event) => event.type)).toEqual(
      kind === "rewrite" ? ["input", "change"] : ["input"],
    )
  })

test("native select supports focus within a closed shadow root", async ({
  page,
}) => {
  await page.evaluate(() => {
    const select = Reflect.get(
      globalThis,
      "selectFixtureControl",
    ) as HTMLSelectElement
    const host = document.createElement("div")
    document.body.append(host)
    host.attachShadow({ mode: "closed" }).append(select)
    select.focus()
    if (document.activeElement !== host) throw new Error("Missing shadow focus")
  })
  expect(await choose(page, [{ index: 1 }])).toEqual({
    ok: true,
    applied: true,
    values: ["g"],
  })
})

test("native selection verification detects a deferred value rollback after the select function returns", async ({
  page,
}) => {
  await page.evaluate(() => {
    const select = Reflect.get(
      globalThis,
      "selectFixtureControl",
    ) as HTMLSelectElement
    select.addEventListener("input", () => {
      queueMicrotask(() => {
        select.value = "r"
      })
    })
  })
  expect(await choose(page, [{ value: "g" }])).toMatchObject({
    ok: true,
    values: ["g"],
  })
  expect(
    await page.evaluate((source) => {
      const verify = new Function(
        `return (${source})`,
      )() as typeof verifyBrowserSelection
      return verify.call(
        Reflect.get(globalThis, "selectFixtureControl") as HTMLSelectElement,
        ["g"],
      )
    }, verifyBrowserSelection.toString()),
  ).toBe(false)
})
