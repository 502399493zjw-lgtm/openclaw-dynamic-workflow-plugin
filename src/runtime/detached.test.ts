import { describe, it, expect, vi } from "vitest";
import { runDetached, type DetachedDeps } from "./detached.js";

describe("runDetached", () => {
  it("creates a flow, runs the engine in background, persists result, schedules a wakeup", async () => {
    // §10.1: a managed flow is created via `createManaged`, returning a record
    // keyed by `flowId` with an optimistic `revision`; terminal state is written
    // through the revision-checked `finish` mutator (no bare `setState`).
    const flow = { flowId: "flow-1", revision: 0 };
    const finish = vi.fn().mockReturnValue({ applied: true, flow });
    const fail = vi.fn().mockReturnValue({ applied: true, flow });
    const createManaged = vi.fn().mockReturnValue(flow);
    const managedFlows = { createManaged, finish, fail };
    // §10.2: arm B one-shot wakeup; returns a best-effort handle (or undefined).
    const scheduleSessionTurn = vi.fn().mockResolvedValue({ id: "job-1" });

    const started = await runDetached({
      managedFlows,
      scheduleSessionTurn,
      sessionKey: "agent:main:x",
      run: async () => "RESULT",
    } as DetachedDeps);

    expect(started.status).toBe("started");
    expect(started.flowId).toBe("flow-1");
    // let the background microtask settle
    await new Promise((r) => setTimeout(r, 5));
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: "flow-1",
        expectedRevision: 0,
        stateJson: { status: "done", result: "RESULT" },
      }),
    );
    expect(scheduleSessionTurn).toHaveBeenCalled();
  });

  it("persists failure via `fail` (not `finish`) when the engine throws", async () => {
    const flow = { flowId: "flow-2", revision: 0 };
    const finish = vi.fn().mockReturnValue({ applied: true, flow });
    const fail = vi.fn().mockReturnValue({ applied: true, flow });
    const managedFlows = { createManaged: vi.fn().mockReturnValue(flow), finish, fail };
    const scheduleSessionTurn = vi.fn().mockResolvedValue(undefined);

    const started = await runDetached({
      managedFlows,
      scheduleSessionTurn,
      sessionKey: "agent:main:x",
      run: async () => {
        throw new Error("boom");
      },
    } as DetachedDeps);

    expect(started.status).toBe("started");
    await new Promise((r) => setTimeout(r, 5));
    expect(finish).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: "flow-2",
        expectedRevision: 0,
        stateJson: { status: "failed", error: "boom" },
      }),
    );
    // §10.2: the wakeup is still scheduled even on failure (best-effort handle).
    expect(scheduleSessionTurn).toHaveBeenCalled();
  });
});
