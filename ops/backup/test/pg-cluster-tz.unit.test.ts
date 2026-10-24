import { describe, expect, it } from "vitest"
import { DRILL_CLUSTER_TIMEZONE } from "./helpers/cluster"

describe("startCluster timezone", () => {
  it("runs initdb/pg_ctl with a non-UTC TZ when requested for drills", () => {
    expect(DRILL_CLUSTER_TIMEZONE).toBe("Asia/Karachi")
  })
})
