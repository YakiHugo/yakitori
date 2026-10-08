import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)

describe.skipIf(process.platform === "win32")(
  "rollout asset durability",
  () => {
    it.each([
      "bytes",
      "paths",
      "promote",
      "copy",
    ])("releases only new %s slots when linking succeeds but directory sync fails", async (operation) => {
      const root = await mkdtemp(join(tmpdir(), "yakitori-asset-sync-"))
      try {
        // Isolate the FileHandle fault injection from other tests. Real files,
        // links and reads exercise the compensation boundary in each API.
        const moduleUrl = new URL(
          "../../src/core/rollout-assets.ts",
          import.meta.url,
        ).href
        const script = `
          import { strict as assert } from "node:assert";
          import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
          import { join } from "node:path";
          import { createRolloutAssets } from ${JSON.stringify(moduleUrl)};
          const root = ${JSON.stringify(root)};
          const operation = ${JSON.stringify(operation)};
          const source = "rollout_source", target = operation === "copy" ? "rollout_target" : source;
          for (const id of new Set([source, target])) await mkdir(join(root, "rollouts", id), { recursive: true });
          const assets = createRolloutAssets(root, { withMutationLease: async (_id, mutate) => mutate() });
          const png = Buffer.alloc(24);
          Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
          png.writeUInt32BE(1,16); png.writeUInt32BE(1,20);
          const changed = Buffer.from(png); changed[12] = 7;
          const items = [ { name: "one.png", data: png }, { name: "two.png", data: png } ];
          const drafts = await assets.importAttachmentBytes(source, "source_draft", items);
          const sourcePaths = items.map((_,index) => join(root, "source-" + index + ".png"));
          for (const path of sourcePaths) await writeFile(path, png);
          const prepare = async (count) => {
            if (operation === "bytes") return assets.importAttachmentBytes(target,"owner",items.slice(0,count));
            if (operation === "paths") return assets.importAttachmentPaths(target,"owner",sourcePaths.slice(0,count));
            const result = await assets[operation === "promote" ? "promoteAttachments" : "copyAttachments"](target,"owner",drafts.slice(0,count));
            return result.attachments;
          };
          const [retained] = await prepare(1);
          const namespace = operation === "bytes" || operation === "paths" ? "staging" : "requests";
          const directory = join(root,"rollouts",target,"files","attachments",namespace,"owner");
          const candidate = join(directory,"2.png");
          const directoryInfo = await stat(directory);
          const probe = await open(join(root,"probe"),"w+");
          const prototype = Object.getPrototypeOf(probe), originalSync = prototype.sync;
          let injected = false;
          prototype.sync = async function () {
            const info = await this.stat();
            if (!injected && info.isDirectory() && info.ino === directoryInfo.ino && info.dev === directoryInfo.dev) {
              try { await stat(candidate); injected = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
              if (injected) throw new Error("injected attachment directory sync failure");
            }
            return originalSync.call(this);
          };
          try {
            await assert.rejects(prepare(2), /injected attachment directory sync failure/);
          } finally {
            prototype.sync = originalSync;
            await probe.close();
          }
          assert.equal(injected,true);
          assert.deepEqual(await assets.read(retained.file),png);
          await assert.rejects(stat(candidate), { code: "ENOENT" });
          // A different payload can claim the rejected slot on retry.
          if (operation === "bytes") items[1].data = changed;
          else if (operation === "paths") await writeFile(sourcePaths[1],changed);
          else {
            const [replacement] = await assets.importAttachmentBytes(source,"replacement",[{name:"two.png",data:changed}]);
            drafts[1] = replacement;
          }
          const retried = await prepare(2);
          assert.deepEqual(await assets.read(retried[1].file),changed);
          assert.deepEqual(await assets.read(retained.file),png);
          process.stdout.write("passed");
        `
        const { stdout } = await execFileAsync(process.execPath, [
          "--input-type=module",
          "--eval",
          script,
        ])
        expect(stdout).toBe("passed")
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  },
)
