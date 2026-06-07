import { describe, it, expect, vi } from "vitest";

// §13: the tool now spawns via a self-connecting GatewayClient (callGatewayFromCli),
// not the injected api.runtime.subagent. Mock that RPC layer to simulate
// agent / agent.wait / chat.history so the unit test exercises the REAL path.
vi.mock("openclaw/plugin-sdk/gateway-runtime", () => {
  const store = new Map<string, string>();
  return {
    callGatewayFromCli: async (method: string, _opts: unknown, params: Record<string, unknown>) => {
      if (method === "agent") {
        store.set(String(params.sessionKey), `echo:${String(params.message)}`);
        return { runId: "r" };
      }
      if (method === "agent.wait") return { status: "ok" };
      if (method === "chat.history") {
        return {
          messages: [
            { role: "assistant", content: [{ type: "text", text: store.get(String(params.sessionKey)) ?? "" }] },
          ],
        };
      }
      return {};
    },
  };
});

import { createWorkflowTool } from "./workflow-tool.js";

describe("workflow tool", () => {
  it("runs a script and returns its result; emits progress", async () => {
    const updates: unknown[] = [];
    const tool = createWorkflowTool();
    // No api.runtime → tool runs inline with the (mocked) self-connecting subagent.
    const ctx = {
      api: { config: { gateway: { port: 18790, auth: { token: "t" } } } },
      toolCallId: "call-1",
      onUpdate: (u: unknown) => updates.push(u),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const result = await tool.execute(
      { script: `phase("scan"); return await parallel([() => agent("A"), () => agent("B")]);` },
      {},
      ctx,
    );
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
