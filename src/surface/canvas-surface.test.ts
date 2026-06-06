import { describe, it, expect, vi } from "vitest";
import { createCanvasSurface } from "./canvas-surface.js";
import type { WorkflowEvent } from "../runtime/workflow-runtime.js";

describe("createCanvasSurface", () => {
  it("renders the phase tree from events and pushes A2UI JSONL via nodes.invoke", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const surface = createCanvasSurface({ nodesInvoke: invoke, nodeId: "node-1" });
    const events: WorkflowEvent[] = [
      { type: "phase", name: "scan" },
      { type: "agent:start", phase: "scan", label: "file1", seq: 1 },
      { type: "agent:done", phase: "scan", label: "file1", seq: 1, status: "ok" },
    ];
    for (const e of events) surface.onEvent(e);
    await surface.flush();
    expect(invoke).toHaveBeenCalled();
    const call = invoke.mock.calls.at(-1)![0];
    expect(call.command).toBe("canvas.a2ui.pushJSONL");
    expect(call.nodeId).toBe("node-1");
    expect(String(call.params.jsonl)).toContain("scan");
    expect(String(call.params.jsonl)).toContain("file1");
  });

  it("is a no-op when no nodeId is available (headless dev gateway)", async () => {
    const invoke = vi.fn();
    const surface = createCanvasSurface({ nodesInvoke: invoke, nodeId: undefined });
    surface.onEvent({ type: "phase", name: "x" });
    await surface.flush();
    expect(invoke).not.toHaveBeenCalled();
  });
});
