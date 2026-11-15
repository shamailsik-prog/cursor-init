import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("node:child_process", () => ({ spawn: vi.fn() }))

import { spawn } from "node:child_process"
import { DOCKER_CLIENT_PATH, runCommand } from "../lib/exec"

const spawnMock = vi.mocked(spawn)

function fakeChild(): EventEmitter {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: { write: () => boolean; on: () => void; once: () => void; end: () => void }
    kill: () => void
  }
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.stdin = { write: () => true, on: () => undefined, once: () => undefined, end: () => undefined }
  proc.kill = () => undefined
  queueMicrotask(() => proc.emit("close", 0))
  return proc
}

beforeEach(() => {
  spawnMock.mockReset()
  spawnMock.mockImplementation(() => fakeChild() as never)
})

describe("docker child environment", () => {
  it("uses a fixed PATH and drops DOCKER_HOST, DOCKER_CONTEXT, and caller PATH", async () => {
    await runCommand(["psql", "-c", "SELECT 1"], {
      pgPrefix: ["docker", "exec", "-i", "pg"],
      exactEnv: true,
      env: {
        NODE_ENV: "test",
        PATH: "/tmp/evil:/usr/bin",
        DOCKER_HOST: "tcp://evil:2375",
        DOCKER_CONTEXT: "prod",
        HOME: "/home/drill",
        PGHOST: "/tmp/sock",
      },
    })
    const opts = spawnMock.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv }
    expect(opts.env.PATH).toBe(DOCKER_CLIENT_PATH)
    expect(opts.env.DOCKER_HOST).toBeUndefined()
    expect(opts.env.DOCKER_CONTEXT).toBeUndefined()
    expect(opts.env.PGHOST).toBeUndefined()
    expect(opts.env.HOME).toBe("/home/drill")
    expect(opts.env.NODE_ENV).toBe("test")
  })

  it("keeps a non-docker child environment", async () => {
    await runCommand(["psql"], {
      exactEnv: true,
      env: { NODE_ENV: "test", PATH: "/tmp/pg", PGHOST: "/tmp/sock" },
    })
    const opts = spawnMock.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv }
    expect(opts.env.PATH).toBe("/tmp/pg")
    expect(opts.env.PGHOST).toBe("/tmp/sock")
  })
})
