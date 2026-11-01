import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

if (process.platform !== "darwin")
  throw new Error("Computer signing setup requires macOS.")

const run = promisify(execFile)
const name = "Yakitori Local Development"
const identities = async () => {
  const { stdout } = await run("/usr/bin/security", [
    "find-identity",
    "-p",
    "codesigning",
  ])
  // A local self-signed identity need not be globally trusted: codesign pins
  // the leaf certificate in its designated requirement. Reject other failures.
  for (const match of stdout.matchAll(
    /^\s*\d+\) [A-Fa-f0-9]{40} "Yakitori Local Development"(.*)$/gm,
  )) {
    const reason = match[1]?.trim()
    if (reason && reason !== "(CSSMERR_TP_NOT_TRUSTED)")
      throw new Error(`${name} is unusable: ${reason}`)
  }
  return [
    ...new Set(
      [
        ...stdout.matchAll(/([A-Fa-f0-9]{40}) "Yakitori Local Development"/g),
      ].map((match) => match[1]),
    ),
  ]
}
const existing = await identities()
if (existing.length > 1)
  throw new Error(
    `Multiple ${name} identities exist; resolve them in Keychain Access before continuing.`,
  )
if (existing.length === 1) {
  console.log(`Reusing ${name}: ${existing[0]}`)
} else {
  // An unusable identity must be repaired, not silently replaced: its signing
  // requirement may already be attached to the user's privacy grants.
  const { stdout } = await run("/usr/bin/security", [
    "find-certificate",
    "-a",
    "-c",
    name,
  ])
  if (stdout.trim())
    throw new Error(
      `${name} has a certificate but no signing identity. Repair its key in Keychain Access; setup will not replace it.`,
    )

  const directory = await mkdtemp(join(tmpdir(), "yakitori-signing-"))
  await chmod(directory, 0o700)
  try {
    const key = join(directory, "private.pem")
    const certificate = join(directory, "certificate.pem")
    const archive = join(directory, "identity.p12")
    const password = randomBytes(32).toString("hex")
    await run("/usr/bin/openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:3072",
      "-nodes",
      "-sha256",
      "-days",
      "3650",
      "-subj",
      `/CN=${name}/`,
      "-keyout",
      key,
      "-out",
      certificate,
      "-addext",
      "basicConstraints=critical,CA:false",
      "-addext",
      "keyUsage=critical,digitalSignature",
      "-addext",
      "extendedKeyUsage=critical,codeSigning",
    ])
    await chmod(key, 0o600)
    await run(
      "/usr/bin/openssl",
      [
        "pkcs12",
        "-export",
        "-inkey",
        key,
        "-in",
        certificate,
        "-name",
        name,
        "-out",
        archive,
        "-passout",
        "env:YAKITORI_P12_PASSWORD",
      ],
      { env: { ...process.env, YAKITORI_P12_PASSWORD: password } },
    )
    const { stdout: keychain } = await run("/usr/bin/security", [
      "default-keychain",
      "-d",
      "user",
    ])
    const path = keychain.trim().replace(/^"|"$/g, "")
    try {
      // Only Apple's codesign tool may use the imported, non-extractable key.
      await run("/usr/bin/security", [
        "import",
        archive,
        "-k",
        path,
        "-P",
        password,
        "-x",
        "-T",
        "/usr/bin/codesign",
      ])
    } catch (error) {
      // execFile's default error includes argv, including the one-time wrapping
      // password. Report the operational error without exposing those arguments.
      if (
        error instanceof Error &&
        "stderr" in error &&
        typeof error.stderr === "string"
      )
        throw new Error(`Keychain import failed: ${error.stderr.trim()}`)
      throw error
    }
    const created = await identities()
    if (created.length !== 1)
      throw new Error(
        `${name} was imported but is not a unique signing identity. Inspect Keychain Access before retrying.`,
      )
    console.log(`Created ${name}: ${created[0]}`)
    console.log(
      "The identity is stored in your keychain without changing certificate trust. Grant Yakitori Computer access once after rebuilding.",
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
