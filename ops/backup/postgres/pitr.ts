import { createWriteStream, promises as fsp } from "node:fs"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { createGunzip } from "node:zlib"
import type { KeyRing } from "../lib/envelope.mjs"
import { BundleWriter, openBundleFile, verifyBundle } from "../lib/bundle"
import { runCommand, psqlArgv } from "../lib/exec"
import { assertPitrDataDirClean } from "./guards"

export async function baseBackup(opts: { outRoot: string; key: Buffer; pgPrefix?: string[]; env?: NodeJS.ProcessEnv }): Promise<string> {
  const env = { ...process.env, ...opts.env }
  const bb = await runCommand(
    ["pg_basebackup", "-D", "-", "--format=tar", "--wal-method=fetch", "--checkpoint=fast", "--manifest-checksums=SHA256"],
    { env, pgPrefix: opts.pgPrefix }
  )
  if (bb.code !== 0) throw new Error(bb.stderr || bb.stdout)
  const writer = await BundleWriter.create(opts.outRoot, "postgres-pitr-base", opts.key)
  const { createGzip } = await import("node:zlib")
  const { Readable } = await import("node:stream")
  const gzChunks: Buffer[] = []
  await pipeline(Readable.from([Buffer.from(bb.stdout, "binary")]), createGzip({ level: 1 }), async function (src) {
    for await (const c of src) gzChunks.push(Buffer.from(c))
  })
  await writer.addBuffer("base.tar.gz", Buffer.concat(gzChunks))
  return await writer.finish({ kind: "pitr-base" })
}

export async function preparePitrRestore(opts: {
  bundleDir: string
  ring: KeyRing
  dataDir: string
  archiveDir: string
  keyFile: string
  target: string
  pgWalScript: string
}): Promise<void> {
  await assertPitrDataDirClean(opts.dataDir)
  const verify = await verifyBundle(opts.bundleDir, opts.ring)
  if (!verify.ok) throw new Error(verify.problems.join("; "))
  await fsp.mkdir(opts.dataDir, { recursive: true, mode: 0o700 })
  const tarPath = path.join(opts.dataDir, "base.tar")
  await pipeline(
    openBundleFile(opts.bundleDir, "base.tar.gz", opts.ring),
    createGunzip(),
    createWriteStream(tarPath)
  )
  const extract = await runCommand(["tar", "-xf", tarPath, "-C", opts.dataDir])
  if (extract.code !== 0) throw new Error(extract.stderr || extract.stdout)
  await fsp.rm(tarPath, { force: true })
  const recovery = `restore_command = 'node ${opts.pgWalScript} restore %f %p --archive-dir ${opts.archiveDir} --key-file ${opts.keyFile}'
recovery_target_name = '${opts.target.replace(/'/g, "''")}'
recovery_target_action = promote
archive_mode = off
`
  await fsp.writeFile(path.join(opts.dataDir, "postgresql.auto.conf"), recovery, "utf8")
  await fsp.writeFile(path.join(opts.dataDir, "recovery.signal"), "", "utf8")
}

export async function waitForPromotion(env: NodeJS.ProcessEnv, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const r = await runCommand(psqlArgv("postgres", ["-t", "-A", "-c", "SELECT pg_is_in_recovery();"]), { env })
    if (r.stdout.trim() === "f") return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error("timeout waiting for promotion")
}
