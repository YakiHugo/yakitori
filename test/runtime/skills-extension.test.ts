import { expect, it } from "vitest"
import { createUserInput } from "../../src/core/user-input.ts"
import type { TurnInput } from "../../src/core/session-io.ts"
import { createSkillsExtension } from "../../src/runtime/skills-extension.ts"
import type { SkillsSource } from "../../src/runtime/skills.ts"

it("keeps a prepared skill input bound to its catalog reader after another source refresh", async () => {
  let generation = 0
  const source: SkillsSource = {
    async load() {
      const captured = ++generation
      return {
        skills: [
          {
            name: "demo",
            description: "Versioned source",
            path: "skills://demo",
            scope: "user",
          },
        ],
        diagnostics: [],
        resources: {
          async resolve(path) {
            return path
          },
          async read() {
            return {
              text: `Package ${captured}`,
              truncated: false,
              byteCount: 9,
            }
          },
        },
      }
    },
  }
  const extension = createSkillsExtension({ source })
  const active = await extension.prepare({ workingDirectory: "/unused" })
  await source.load({ workingDirectory: "/unused" })
  const submitted: TurnInput = {
    submissionId: "selected_skill",
    content: createUserInput("$demo"),
  }
  const expanded = await active.prepareInput?.(submitted, [], () => {})
  expect(expanded).toMatchObject([
    {
      role: "user",
      content: [{ type: "text", text: expect.stringContaining("Package 1") }],
    },
  ])
  expect(JSON.stringify(expanded)).not.toContain("Package 2")
})
