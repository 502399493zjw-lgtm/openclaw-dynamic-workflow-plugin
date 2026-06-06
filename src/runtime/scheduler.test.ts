import { describe, it, expect } from "vitest";
import { createScheduler } from "./scheduler.js";

describe("createScheduler", () => {
  it("never runs more than `limit` tasks concurrently", async () => {
    const sched = createScheduler({ limit: 4 });
    let active = 0;
    let peak = 0;
    const task = () =>
      sched.schedule(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return true;
      });
    await Promise.all(Array.from({ length: 32 }, task));
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("returns each task's result and preserves caller order", async () => {
    const sched = createScheduler({ limit: 2 });
    const results = await Promise.all([1, 2, 3].map((n) => sched.schedule(async () => n * 10)));
    expect(results).toEqual([10, 20, 30]);
  });
});
