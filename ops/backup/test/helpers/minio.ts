import { type ChildProcess } from "node:child_process"
import { rmSync } from "node:fs"

export async function stopMinioServer(proc: ChildProcess, dataDir: string): Promise<void> {
  if (!proc.killed) {
    proc.kill("SIGTERM")
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL")
      resolve()
    }, 5000)
    proc.once("exit", () => {
      clearTimeout(timer)
      resolve()
    })
  })
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      rmSync(dataDir, { recursive: true, force: true })
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOTEMPTY" && (err as NodeJS.ErrnoException).code !== "EBUSY") {
        throw err
      }
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)))
    }
  }
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
