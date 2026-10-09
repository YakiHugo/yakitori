import { readdirSync, readFileSync } from "node:fs"
import { dirname, resolve, sep } from "node:path"
import ts from "typescript"
import { expect, it } from "vitest"

function imports(path: string): readonly string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  )
  const specifiers: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (node.moduleSpecifier.text === "@modelcontextprotocol/sdk/types.js") {
        expect(
          ts.isImportDeclaration(node) && node.importClause?.isTypeOnly,
        ).toBe(true)
      }
      specifiers.push(node.moduleSpecifier.text)
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      specifiers.push(node.argument.literal.text)
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    )
      specifiers.push(node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return specifiers
}

it("keeps the application contract independent of native and server implementations", () => {
  const directory = resolve("src/protocol")
  for (const filename of readdirSync(directory).filter((name) =>
    name.endsWith(".ts"),
  )) {
    for (const specifier of imports(resolve(directory, filename))) {
      if (specifier === "@modelcontextprotocol/sdk/types.js") continue
      expect(specifier.startsWith("./"), filename).toBe(true)
      expect(dirname(resolve(directory, specifier)), filename).toBe(directory)
    }
  }
})

it("keeps the GUI dependency graph out of native and server implementations", () => {
  const directory = resolve("src/gui")
  const forbidden = ["core", "kernel", "runtime", "server"].map((name) =>
    resolve("src", name),
  )
  const visited = new Set<string>()
  const visit = (path: string): void => {
    if (visited.has(path)) return
    visited.add(path)
    for (const specifier of imports(path)) {
      if (!specifier.startsWith(".")) continue
      const imported = resolve(dirname(path), specifier)
      expect(
        forbidden.some(
          (root) => imported === root || imported.startsWith(`${root}${sep}`),
        ),
        `${path}: ${specifier}`,
      ).toBe(false)
      if (/\.tsx?$/.test(imported)) visit(imported)
    }
  }
  for (const filename of readdirSync(directory, { recursive: true })) {
    if (/\.tsx?$/.test(String(filename)))
      visit(resolve(directory, String(filename)))
  }
})

it("keeps the engine port independent of native contract aliases", () => {
  for (const specifier of imports(resolve("src/server/engines/engine.ts"))) {
    expect(specifier.startsWith("../../protocol/"), specifier).toBe(true)
  }
})
