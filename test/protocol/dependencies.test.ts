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
        if (
          ts.isImportDeclaration(node) &&
          node.importClause?.isTypeOnly &&
          node.moduleSpecifier.text === "@modelcontextprotocol/sdk/types.js"
        )
          return
        expect(node.moduleSpecifier.text.startsWith("./"), filename).toBe(true)
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
        if (node.argument.literal.text === "@modelcontextprotocol/sdk/types.js")
          return
        expect(node.argument.literal.text.startsWith("./"), filename).toBe(true)
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

it("keeps GUI wire types out of server implementation modules", () => {
  const directory = resolve("src/gui")
  const server = resolve("src/server")
  for (const filename of readdirSync(directory, { recursive: true }).filter(
    (name) => /\.tsx?$/.test(String(name)),
  )) {
    const path = resolve(directory, String(filename))
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
        const imported = resolve(dirname(path), node.moduleSpecifier.text)
        // Asset URL construction is a renderer-safe helper, not a wire type.
        expect(
          imported.startsWith(`${server}/`) &&
            imported !== resolve(server, "asset-url.ts"),
          String(filename),
        ).toBe(false)
      }
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      ) {
        expect(
          resolve(dirname(path), node.argument.literal.text).startsWith(
            `${server}/`,
          ),
          String(filename),
        ).toBe(false)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
})
