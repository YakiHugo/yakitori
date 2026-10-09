import { readdirSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import ts from "typescript"
import { expect, it } from "vitest"

it("keeps the application contract independent of native and server implementations", () => {
  const directory = resolve("src/protocol")
  for (const filename of readdirSync(directory).filter((name) =>
    name.endsWith(".ts"),
  )) {
    const path = resolve(directory, filename)
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    )
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        expect(
          dirname(resolve(directory, node.moduleSpecifier.text)),
          filename,
        ).toBe(directory)
      }
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      ) {
        expect(
          dirname(resolve(directory, node.argument.literal.text)),
          filename,
        ).toBe(directory)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
})
