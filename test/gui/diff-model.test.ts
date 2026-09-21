import { expect, it } from "vitest"
import { parseDiff } from "../../src/gui/components/cells/diff-model.ts"

it("tracks old and new line numbers independently across replacement hunks", () => {
  const model = parseDiff(
    "--- a/example.txt\n+++ b/example.txt\n@@ -10,3 +20,4 @@ function\n before\n-old\n+new\n+another\n after\n@@ -30 +41 @@\n-last\n+next\n",
  )
  expect(model.kind).toBe("unified")
  if (model.kind !== "unified") throw new Error("Expected a unified diff")
  expect(model.files[0]).toMatchObject({
    oldPath: "example.txt",
    newPath: "example.txt",
    additions: 3,
    deletions: 2,
    rows: [
      { kind: "hunk", text: "@@ -10,3 +20,4 @@ function" },
      { kind: "context", oldLine: 10, newLine: 20 },
      { kind: "deletion", oldLine: 11 },
      { kind: "addition", newLine: 21 },
      { kind: "addition", newLine: 22 },
      { kind: "context", oldLine: 12, newLine: 23 },
      { kind: "hunk", text: "@@ -30 +41 @@" },
      { kind: "deletion", oldLine: 30 },
      { kind: "addition", newLine: 41 },
    ],
  })
  expect(model.files[0]?.rows[2]?.newLine).toBeUndefined()
  expect(model.files[0]?.rows[3]?.oldLine).toBeUndefined()
})

it("parses added and deleted files without consuming no-newline annotations", () => {
  const model = parseDiff(
    "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+\n\\ No newline at end of file\ndiff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-goodbye\n\\ No newline at end of file",
  )
  expect(model.kind).toBe("unified")
  if (model.kind !== "unified") throw new Error("Expected a unified diff")
  expect(model.files).toHaveLength(2)
  expect(model.files[0]).toMatchObject({
    oldPath: "/dev/null",
    newPath: "new.txt",
    additions: 2,
    deletions: 0,
  })
  expect(model.files[1]).toMatchObject({
    oldPath: "old.txt",
    newPath: "/dev/null",
    additions: 0,
    deletions: 1,
  })
  expect(model.files[0]?.rows.at(-1)).toMatchObject({
    kind: "note",
    text: "\\ No newline at end of file",
  })
})

it("preserves filename spaces and removes timestamp metadata from headers", () => {
  const model = parseDiff(
    "--- a/old name.txt\t2026-09-20\n+++ b/new name.txt\t2026-09-21\n@@ -1 +1 @@\n-old\n+new",
  )
  expect(model.kind).toBe("unified")
  if (model.kind !== "unified") throw new Error("Expected a unified diff")
  expect(model.files[0]).toMatchObject({
    oldPath: "old name.txt",
    newPath: "new name.txt",
  })
})

it.each([
  "@@ -1,2 +1,2 @@\n-old\n+new",
  "@@ -1 +1 @@\n-old\n+new\n+extra",
  "--- a/file.txt\n+++ b/file.txt\n@@ -1",
  "--- a/file.txt\n+++ b/file.txt",
])("uses raw fallback when hunk ranges cannot be trusted: %s", (text) => {
  expect(parseDiff(text)).toEqual({ kind: "raw", reason: "incomplete" })
})

it.each([
  "Binary files a/image.png and b/image.png differ",
  "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-old\n+new\n*** End Patch",
  "@@@ -1,1 -1,1 +1,1 @@@\n++combined",
  '--- "a/hello\\qworld.ts"\n+++ "b/hello\\qworld.ts"\n@@ -1 +1 @@\n-old\n+new',
  '--- "a/\\377.ts"\n+++ "b/\\377.ts"\n@@ -1 +1 @@\n-old\n+new',
])("retains unsupported patch formats as raw text: %s", (text) => {
  expect(parseDiff(text).kind).toBe("raw")
})

it.each([
  [String.raw`\346\226\207\344\273\266.ts`, "文件.ts"],
  [String.raw`hello\t\"world\"\\next.ts`, 'hello\t"world"\\next.ts'],
])("decodes Git's quoted filename %s without inventing a rename", (encoded, path) => {
  const model = parseDiff(
    `--- "a/${encoded}"\n+++ "b/${encoded}"\n@@ -1 +1 @@\n-old\n+new`,
  )
  expect(model.kind).toBe("unified")
  if (model.kind !== "unified") throw new Error("Expected a unified diff")
  expect(model.files[0]).toMatchObject({ oldPath: path, newPath: path })
})

it("does not omit a metadata-only file after a text change", () => {
  expect(
    parseDiff(
      "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/b.sh b/b.sh\nold mode 100644\nnew mode 100755\n",
    ),
  ).toEqual({ kind: "raw", reason: "unsupported" })
})
