import { spawnSync } from "node:child_process"
import { existsSync, rmSync } from "node:fs"

type Job = { scratch?: string; dataDir?: string; env?: NodeJS.ProcessEnv }

const jobs = new Set<Job>()
let installed = false

function stopCluster(job: Job): void {
  if (!job.dataDir || !existsSync(job.dataDir)) return
  try {
    spawnSync("pg_ctl", ["-D", job.dataDir, "-m", "immediate", "stop"], {
      env: job.env,
      stdio: "ignore",
    })
  } catch {
    // the postmaster is already gone
  }
  rmSync(job.dataDir, { recursive: true, force: true })
}

/** Remove registered plaintext and stop registered clusters. Safe to call more than once. */
export function runEmergencyCleanup(): void {
  for (const job of [...jobs]) {
    if (job.scratch) rmSync(job.scratch, { recursive: true, force: true })
    stopCluster(job)
  }
}

function install(): void {
  if (installed) return
  installed = true
  const onFault = () => {
    runEmergencyCleanup()
  }
  process.on("uncaughtException", onFault)
  process.on("unhandledRejection", onFault)
}

export function registerPlaintext(scratch: string): () => void {
  install()
  const job: Job = { scratch }
  jobs.add(job)
  return () => jobs.delete(job)
}

export function registerCluster(dataDir: string, env: NodeJS.ProcessEnv): () => void {
  install()
  const job: Job = { dataDir, env }
  jobs.add(job)
  return () => jobs.delete(job)
}
