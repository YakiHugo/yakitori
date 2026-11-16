import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { flockSync } from "fs-ext"

export type ContentInput = {
  path: string
  exclude?: (relativePath: string) => boolean
}

/** Hash bytes and executable modes, never mtimes or Git's clean/dirty bit. */
export async function fingerprint(inputs: ContentInput[]): Promise<{
  digest: string
  present: boolean
}> {
  const hash = createHash("sha256")
  const fileHashes = new Map<string, string>()
  let present = true
  async function visit(
    path: string,
    name: string,
    input: ContentInput,
    ancestors = new Set<string>(),
  ): Promise<void> {
    if (input.exclude?.(name)) return
    const stat = await lstat(path).catch((error: unknown) => {
      if (isMissing(error)) return undefined
      throw error
    })
    hash.update(JSON.stringify([name, stat?.mode && stat.mode & 0o111]))
    if (!stat) {
      present = false
      hash.update("missing")
    } else if (stat.isSymbolicLink()) {
      hash.update(JSON.stringify(["symlink", await readlink(path)]))
      await visit(
        resolve(dirname(path), await readlink(path)),
        `${name}/target`,
        input,
        ancestors,
      )
    } else if (stat.isDirectory()) {
      const physicalPath = await realpath(path)
      if (ancestors.has(physicalPath))
        throw new Error(`Cyclic build input: ${path}`)
      const nextAncestors = new Set([...ancestors, physicalPath])
      hash.update("directory")
      for (const child of (await readdir(path)).sort()) {
        await visit(
          join(path, child),
          name ? `${name}/${child}` : child,
          input,
          nextAncestors,
        )
      }
    } else if (stat.isFile()) {
      hash.update(JSON.stringify(["file", stat.size]))
      const identity = `${stat.dev}:${stat.ino}`
      let digest = fileHashes.get(identity)
      if (digest === undefined) {
        const content = createHash("sha256")
        for await (const chunk of createReadStream(path)) content.update(chunk)
        digest = content.digest("hex")
        fileHashes.set(identity, digest)
      }
      hash.update(digest)
    } else {
      throw new Error(`Unsupported build input: ${path}`)
    }
  }
  for (const [index, input] of inputs.entries()) {
    await visit(input.path, String(index), {
      ...input,
      exclude: input.exclude
        ? (name) => input.exclude?.(name.split("/").slice(1).join("/")) ?? false
        : () => false,
    })
  }
  return { digest: hash.digest("hex"), present }
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

type CachedStage = {
  name: string
  inputs: ContentInput[]
  context: unknown
  outputs: string[]
  build: () => Promise<void>
}

/** One latest record per stage: no historical artifact copies accumulate. */
export async function cachedBuild(
  cacheDirectory: string,
  stage: CachedStage,
): Promise<"hit" | "built"> {
  if (!/^[a-z][a-z-]*$/.test(stage.name))
    throw new Error("Invalid build cache stage name.")
  const recordPath = join(cacheDirectory, `${stage.name}.json`)
  const input = await fingerprint(stage.inputs)
  const key = createHash("sha256")
    .update(JSON.stringify([2, stage.context, input.digest]))
    .digest("hex")
  const recordText = await readFile(recordPath, "utf8").catch(
    (error: unknown) => {
      if (isMissing(error)) return undefined
      throw error
    },
  )
  let record: unknown
  try {
    record = recordText === undefined ? undefined : JSON.parse(recordText)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
  }
  const outputInputs = stage.outputs.map((path) => ({ path }))
  if (
    typeof record === "object" &&
    record !== null &&
    "key" in record &&
    record.key === key
  ) {
    const output = await fingerprint(outputInputs)
    if (
      output.present &&
      "output" in record &&
      record.output === output.digest
    ) {
      console.log(`[build-cache] ${stage.name}: hit`)
      return "hit"
    }
  }
  // Remove the previous success marker before a build can partially modify output.
  await rm(recordPath, { force: true })
  console.log(`[build-cache] ${stage.name}: building`)
  await stage.build()
  if ((await fingerprint(stage.inputs)).digest !== input.digest) {
    throw new Error(
      `${stage.name} inputs changed during the build; run it again.`,
    )
  }
  const output = await fingerprint(outputInputs)
  if (!output.present)
    throw new Error(`${stage.name} did not produce its required outputs.`)
  await mkdir(cacheDirectory, { recursive: true })
  const temporary = `${recordPath}.${process.pid}.tmp`
  await writeFile(
    temporary,
    `${JSON.stringify({ key, output: output.digest })}\n`,
  )
  await rename(temporary, recordPath)
  return "built"
}

/** Serialize output mutation across package/build processes in this checkout. */
export async function withBuildCacheLock<T>(
  cacheDirectory: string,
  action: () => Promise<T>,
): Promise<T> {
  await mkdir(cacheDirectory, { recursive: true })
  // Keep the inode in place. Closing (including process termination) releases
  // flock; unlinking a lock file could let two processes lock different inodes.
  const lock = await open(join(cacheDirectory, "build.lock"), "a+")
  try {
    try {
      flockSync(lock.fd, "exnb")
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "EAGAIN" || error.code === "EWOULDBLOCK")
      ) {
        throw new Error(`Another desktop build owns ${cacheDirectory}.`)
      }
      throw error
    }
    await lock.truncate(0)
    await lock.writeFile(`${process.pid}\n`)
    return await action()
  } finally {
    await lock.close()
  }
}
