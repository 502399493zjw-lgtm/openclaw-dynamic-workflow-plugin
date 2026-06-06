import { describe, it, expect } from "vitest";
import { createWorkflowTool } from "./workflow-tool.js";
import type { SubagentRuntime } from "./skeleton/spawn-bridge.js";

function fakeSubagent(): SubagentRuntime {
  const store = new Map<string, string>();
  return {
    run: async ({ sessionKey, message }) => {
      store.set(sessionKey, `echo:${message}`);
      return { runId: "r" };
    },
    waitForRun: async () => ({ status: "ok" }),
    getSessionMessages: async ({ sessionKey }) => ({
      messages: [{ role: "assistant", content: [{ type: "text", text: store.get(sessionKey) ?? "" }] }],
    }),
  };
}

describe("workflow tool", () => {
  it("runs a script and returns its result; emits progress", async () => {
    const updates: unknown[] = [];
    const tool = createWorkflowTool();
    const ctx = {
      api: { runtime: { subagent: fakeSubagent() } },
      toolCallId: "call-1",
      onUpdate: (u: unknown) => updates.push(u),
    } as any;
    const result = await tool.execute(
      { script: `phase("scan"); return await parallel([() => agent("A"), () => agent("B")]);` },
      {},
      ctx,
    );
    // result is wrapped as the tool's return; assert it carries the two echoes
    const text = JSON.stringify(result);
    expect(text).toContain("echo:A");
    expect(text).toContain("echo:B");
    expect(updates.length).toBeGreaterThan(0);
  });

  it("exposes the tool's static metadata", () => {
    const tool = createWorkflowTool();
    expect(tool.name).toBe("workflow");
    expect(typeof tool.execute).toBe("function");
    expect(tool.parameters).toBeDefined();
  });
});
