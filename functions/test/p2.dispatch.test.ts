import { logger } from "firebase-functions"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CloudTasksDispatcher, jobRuntime, runtimeDeps, type JobDeps, type JobTask, type TaskQueueLike } from "../src/p2/dispatch"
import { onJobCreatedCore, parseJobTask } from "../src/p2/functions"
import { JOB_HANDLER_BUDGET_MS } from "../src/p2/constants"
import { logDeadLetterAlert } from "../src/p2/jobEvents"
import { FakeClock, T0, testDeps } from "./jobs"

/** The Cloud Tasks dispatcher, the trigger core and the task-body parser (spec P3-5). No emulator. */

type Call = [JobTask, { id: string; scheduleTime?: Date }]

class FakeQueue implements TaskQueueLike {
  readonly calls: Call[] = []
  async enqueue(data: JobTask, opts: { id: string; scheduleTime?: Date }): Promise<void> {
    this.calls.push([data, opts])
  }
}

const dispatcherRejecting = (err: unknown) => new CloudTasksDispatcher(() => ({ enqueue: () => Promise.reject(err) }))

describe("P2 dispatch (P3-5)", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete jobRuntime.deps
  })

  it("CloudTasksDispatcher enqueues { jobId, seq } as task jobId-seq; task-already-exists is success; other errors reject", async () => {
    const fake = new FakeQueue()
    const t: JobTask = { jobId: "jabc", seq: 0 }
    await new CloudTasksDispatcher(() => fake).dispatch({ jobId: "jabc", seq: 2 }, { scheduleAt: T0 })
    expect(fake.calls).toEqual([[{ jobId: "jabc", seq: 2 }, { id: "jabc-2", scheduleTime: new Date(T0) }]])
    await new CloudTasksDispatcher(() => fake).dispatch({ jobId: "jabc", seq: 3 })
    expect(fake.calls[1][1]).toEqual({ id: "jabc-3" })
    expect("scheduleTime" in fake.calls[1][1]).toBe(false)
    await expect(dispatcherRejecting({ code: "functions/task-already-exists" }).dispatch(t)).resolves.toBeUndefined()
    await expect(dispatcherRejecting({ code: "functions/unavailable" }).dispatch(t)).rejects.toMatchObject({ code: "functions/unavailable" })
  })

  it("CloudTasksDispatcher resolves its queue on first dispatch, once, not at construction", async () => {
    const fake = new FakeQueue()
    const resolve = vi.fn(() => fake)
    const dispatcher = new CloudTasksDispatcher(resolve)
    expect(resolve).not.toHaveBeenCalled()
    await dispatcher.dispatch({ jobId: "j1", seq: 0 })
    await dispatcher.dispatch({ jobId: "j1", seq: 1 })
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(fake.calls.map(([data]) => data)).toEqual([
      { jobId: "j1", seq: 0 },
      { jobId: "j1", seq: 1 },
    ])
    // The production default does no work at construction (no Admin app, no network).
    expect(() => new CloudTasksDispatcher()).not.toThrow()
  })

  it("runtimeDeps: the jobRuntime override when set, else the production defaults", () => {
    const d = runtimeDeps()
    expect(d.dispatcher).toBeInstanceOf(CloudTasksDispatcher)
    expect(d.alert).toBe(logDeadLetterAlert)
    expect(d.handlerBudgetMs).toBe(JOB_HANDLER_BUDGET_MS)
    expect(Math.abs(d.clock() - Date.now())).toBeLessThan(1000)
    const override: JobDeps = testDeps(new FakeClock(T0))
    jobRuntime.deps = override
    expect(runtimeDeps()).toBe(override)
  })

  it("onJobCreatedCore dispatches seq 0 for an engine row only; a duplicate trigger reuses task j…-0", async () => {
    const d = testDeps(new FakeClock(T0))
    await onJobCreatedCore("j1", { engine: "p2" }, d)
    await onJobCreatedCore("j1", { engine: "p2" }, d)
    await onJobCreatedCore("j2", { jobType: "ocr" }, d)
    await onJobCreatedCore("j3", undefined, d)
    expect(d.dispatcher.tasks).toEqual([{ jobId: "j1", seq: 0, scheduleAt: null }])
  })

  it("onJobCreatedCore logs a dispatch failure by code and swallows it (the sweeper recovers)", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined)
    const d = { ...testDeps(new FakeClock(T0)), dispatcher: dispatcherRejecting(Object.assign(new Error("quota on jsecret"), { code: "functions/unavailable" })) }
    await expect(onJobCreatedCore("j1", { engine: "p2" }, d)).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith("job dispatch failed", { code: "functions/unavailable" })
  })

  it("parseJobTask accepts { jobId, seq } only", () => {
    expect(parseJobTask({ jobId: "j1", seq: 0 })).toEqual({ jobId: "j1", seq: 0 })
    expect(parseJobTask({ jobId: "j1", seq: 7 })).toEqual({ jobId: "j1", seq: 7 })
    for (const bad of [
      { jobId: "a/b", seq: 0 },
      { jobId: "j1", seq: -1 },
      { jobId: "j1", seq: 1.5 },
      { jobId: "j1", seq: 0, payload: {} },
      { jobId: "", seq: 0 },
      { jobId: "j1", seq: "0" },
      { jobId: "j1", seq: Number.MAX_SAFE_INTEGER + 1 },
      { jobId: "j1" },
      { seq: 0 },
      [],
      "j1-0",
      null,
      undefined,
    ]) {
      expect(parseJobTask(bad)).toBeNull()
    }
  })
})
