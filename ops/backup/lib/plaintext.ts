import { createWriteStream } from "node:fs"
import { constants, open } from "node:fs/promises"
import type { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

/** Create a new file. A symlink is not followed and an existing path is left untouched. */
const EXCLUSIVE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW

async function exclusiveHandle(dest: string) {
  const handle = await open(dest, EXCLUSIVE, 0o600)
  await handle.chmod(0o600)
  return handle
}

export async function writePlaintextExclusive(dest: string, bytes: Buffer | string): Promise<void> {
  const handle = await exclusiveHandle(dest)
  try {
    await handle.writeFile(bytes)
  } finally {
    await handle.close()
  }
}

export async function writePlaintextExclusiveStream(dest: string, source: Readable): Promise<void> {
  const handle = await exclusiveHandle(dest)
  try {
    const out = createWriteStream(dest, { fd: handle.fd, autoClose: false })
    await pipeline(source, out)
  } finally {
    await handle.close()
  }
}
