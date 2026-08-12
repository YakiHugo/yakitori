import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

const sourceDirectory = "src/runtime/prompts"
const outputDirectory = "dist/desktop/prompts"
const promptFiles = (await readdir(sourceDirectory)).filter((fileName) =>
  fileName.endsWith(".md"),
)

for (const fileName of promptFiles) {
  const [source, output] = await Promise.all([
    readFile(join(sourceDirectory, fileName)),
    readFile(join(outputDirectory, fileName)),
  ])
  if (!source.equals(output)) {
    throw new Error(`Desktop prompt asset differs from source: ${fileName}`)
  }
}
