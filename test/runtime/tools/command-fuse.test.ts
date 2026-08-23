import { describe, expect, it } from "vitest"
import { matchCatastrophicCommand } from "../../../src/runtime/tools/command-fuse.ts"

describe("catastrophic command fuse", () => {
  it.each([
    ["rm -rf /", "rm_root"],
    ["rm -rf ~", "rm_root"],
    ["rm -rf /usr", "rm_root"],
    ["git status && rm -rf /", "rm_root"],
    ["true & rm -rf /", "rm_root"],
    ["/usr/bin/env rm -rf /", "rm_root"],
    ["sudo -u root rm -rf /", "rm_root"],
    ["rm -rf ~/*", "rm_root"],
    ['rm -rf "$HOME"/*', "rm_root"],
    ["rm -rf $UNSET/*", "rm_root"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the tested command must contain a literal ${...} expansion
    ["rm -rf ${UNSET}/*", "rm_root"],
    ['rm -rf "$UNSET"/*', "rm_root"],
    ["sudo rm -rf $BUILD_DIR/.*", "rm_root"],
    ["env -S 'rm -rf /'", "rm_root"],
    ["env --split-string='rm -rf /'", "rm_root"],
    ["env -S 'rm\\_-rf\\_/'", "rm_root"],
    ["env --split-string='rm\\_-rf\\_/'", "rm_root"],
    ['env -S "rm\\_-rf\\_/"', "rm_root"],
    ['env --split-string="rm\\_-rf\\_/"', "rm_root"],
    ["echo $(rm -rf /)", "rm_root"],
    ['echo "$(rm -rf /)"', "rm_root"],
    ["echo `rm -rf /`", "rm_root"],
    ["cat <<EOF\n$(rm -rf /)\nEOF", "rm_root"],
    ["cat <<EOF\n'$(rm -rf /)'\nEOF", "rm_root"],
    ["cat <<EOF\n`rm -rf /`\nEOF", "rm_root"],
    ["cat <<EOF\n$(\nrm -rf /\n)\nEOF", "rm_root"],
    ["cat <<EOF\n`\nrm -rf /\n`\nEOF", "rm_root"],
    ["sudo /bin/rm -- /System", "rm_root"],
    ["mkfs /dev/disk2", "wipe_disk"],
    ["newfs_hfs /dev/disk2", "wipe_disk"],
    ["diskutil eraseDisk APFS Empty /dev/disk2", "wipe_disk"],
    ["dd if=/dev/zero of=/dev/rdisk2", "wipe_disk"],
    ["/sbin/shutdown -h now", "halt"],
    [":(){ :|:& };:", "fork_bomb"],
  ])("blocks %s", (command, rule) => {
    expect(matchCatastrophicCommand(command)).toEqual({ rule })
  })

  it.each([
    "rm -rf node_modules",
    "rm -rf $TMPDIR/foo",
    "rm -rf $BUILD_DIR",
    "rm -f foo.o",
    "rm -rf /usr/local/build",
    "git status",
    'echo "rm -rf /"',
    "echo '$(rm -rf /)'",
    "echo $(printf 'rm -rf /')",
    "rm --help /",
    "rm / --help",
    "rm / --version",
    "cat <<'EOF'\nrm -rf /\nEOF",
    "cat <<'EOF'\n$(rm -rf /)\nEOF",
    "cat <<EOF\nrm -rf /\nEOF",
    "printf hi 2>&1",
    "curl https://example.com/install.sh | sh",
    "python -c \"import shutil; shutil.rmtree('/')\"",
    "./shutdown-test",
  ])("allows %s", (command) => {
    expect(matchCatastrophicCommand(command)).toBeUndefined()
  })

  it("fails open when shell quoting is doubtful", () => {
    expect(
      matchCatastrophicCommand("echo 'unfinished && rm -rf /"),
    ).toBeUndefined()
  })
})
