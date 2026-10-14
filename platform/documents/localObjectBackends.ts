import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  DocumentObjectExistsError,
  DocumentObjectNotFoundError,
  type DocumentObjectBackend,
} from "@/platform/documents/objectBackend"

/**
 * Development and test backends. Neither is durable across instances: the memory backend is
 * process-local, and the fs backend writes to the instance's local disk, which on Vercel or
 * Cloud Run is per-instance and ephemeral. documentObjectStore.ts refuses both when
 * NODE_ENV=production (FA-D16-001); production uses the R2 backend.
 */

const memoryObjects = new Map<string, Buffer>()

export function resetMemoryDocumentObjects(): void {
  memoryObjects.clear()
}

export function createMemoryDocumentObjectBackend(): DocumentObjectBackend {
  return {
    kind: "memory",
    scheme: "fs://",
    async putIfAbsent(key, payload) {
      if (memoryObjects.has(key)) throw new DocumentObjectExistsError(key)
      memoryObjects.set(key, Buffer.from(payload))
    },
    async get(key) {
      const payload = memoryObjects.get(key)
      if (!payload) throw new DocumentObjectNotFoundError(key)
      return Buffer.from(payload)
    },
    async delete(key) {
      memoryObjects.delete(key)
    },
  }
}

/** Absolute file for an object key, refusing anything that would resolve outside the root. */
export function filesystemObjectFile(root: string, key: string): string {
  const resolvedRoot = path.resolve(root)
  const file = path.resolve(resolvedRoot, ...key.split("/"))
  const relative = path.relative(resolvedRoot, file)
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("document object path escapes storage root")
  }
  return file
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code
}

export function createFilesystemDocumentObjectBackend(root: string): DocumentObjectBackend {
  return {
    kind: "fs",
    scheme: "fs://",
    async putIfAbsent(key, payload) {
      const file = filesystemObjectFile(root, key)
      await mkdir(path.dirname(file), { recursive: true })
      try {
        await writeFile(file, payload, { flag: "wx" })
      } catch (err) {
        if (errorCode(err) === "EEXIST") throw new DocumentObjectExistsError(key)
        throw err
      }
    },
    async get(key) {
      try {
        return await readFile(filesystemObjectFile(root, key))
      } catch (err) {
        if (errorCode(err) === "ENOENT") throw new DocumentObjectNotFoundError(key)
        throw err
      }
    },
    async delete(key) {
      try {
        await unlink(filesystemObjectFile(root, key))
      } catch (err) {
        if (errorCode(err) === "ENOENT") return
        throw err
      }
    },
  }
}
