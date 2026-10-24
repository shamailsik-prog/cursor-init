import { runCommand } from "../lib/exec"

/** PITR drills require PostgreSQL 16 client programs on PATH (vitest.config). */
export async function assertPitrClientTools(): Promise<void> {
  const r = await runCommand(["bash", "-lc", "command -v initdb && command -v pg_basebackup"], {
    env: { ...process.env, PATH: `/usr/lib/postgresql/16/bin:${process.env.PATH ?? ""}` },
  })
  if (r.code !== 0) {
    throw new Error(
      "PITR drill prerequisites missing: install PostgreSQL 16 client tools (initdb, pg_basebackup) or set PATH"
    )
  }
}
