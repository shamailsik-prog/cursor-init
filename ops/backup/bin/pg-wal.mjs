#!/usr/bin/env node
// WAL archive_command / restore_command helper (spec R7). Dependency-free aside from envelope.mjs.
import { createReadStream, createWriteStream, promises as fsp } from "node:fs"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import {
  createDecryptStream,
  createEncryptStream,
  decryptBuffer,
  encryptBuffer,
  makeKeyRing,
  parseMasterKey,
} from "../lib/envelope.mjs"

async function loadKeyFromFile(file) {
  const text = (await fsp.readFile(file, "utf8")).trim()
  return parseMasterKey(text)
}

async function archive(segmentPath, fileName, archiveDir, key) {
  const dest = path.join(archiveDir, `${fileName}.skb`)
  const plain = await fsp.readFile(segmentPath)
  const ring = makeKeyRing(key)
  let existing = null
  try {
    existing = await fsp.readFile(dest)
  } catch {
    existing = null
  }
  if (existing) {
    try {
      const prior = decryptBuffer(ring, existing)
      if (prior.equals(plain)) return 0
      return 1
    } catch {
      return 127
    }
  }
  const temp = `${dest}.part`
  const sealed = encryptBuffer(key, plain)
  await fsp.writeFile(temp, sealed)
  await fsp.rename(temp, dest)
  return 0
}

async function restore(fileName, destPath, archiveDir, ring) {
  const src = path.join(archiveDir, `${fileName}.skb`)
  try {
    await fsp.access(src)
  } catch {
    return 1
  }
  const temp = `${destPath}.part`
  try {
    await pipeline(createReadStream(src), createDecryptStream(ring), createWriteStream(temp))
    await fsp.rename(temp, destPath)
    return 0
  } catch {
    await fsp.rm(temp, { force: true })
    return 127
  }
}

async function main() {
  const cmd = process.argv[2]
  const rest = process.argv.slice(3)
  let keyFile
  let archiveDir
  const positional = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--key-file") keyFile = rest[++i]
    else if (rest[i] === "--archive-dir") archiveDir = rest[++i]
    else positional.push(rest[i])
  }
  if (!keyFile) {
    console.error("pg-wal: missing --key-file")
    process.exit(127)
  }
  const key = await loadKeyFromFile(keyFile)
  const ring = makeKeyRing(key)
  if (cmd === "archive") {
    const [segmentPath, fileName] = positional
    if (!archiveDir) {
      console.error("pg-wal: missing --archive-dir")
      process.exit(127)
    }
    process.exit(await archive(segmentPath, fileName, archiveDir, key))
  }
  if (cmd === "restore") {
    const [fileName, destPath] = positional
    if (!archiveDir) {
      console.error("pg-wal: missing --archive-dir")
      process.exit(127)
    }
    process.exit(await restore(fileName, destPath, archiveDir, ring))
  }
  console.error(`pg-wal: unknown command ${cmd}`)
  process.exit(127)
}

main().catch((err) => {
  console.error(err)
  process.exit(127)
})
