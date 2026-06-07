import { describe, it, expect, vi } from "vitest";

// §13: the tool now spawns via a self-connecting GatewayClient (callGatewayFromCli),
// not the injected api.runtime.subagent. Mock that RPC layer to simulate
// agent / agent.wait / chat.history so the unit test exercises the REAL path.
vi.mock("openclaw/plugin-sdk/gateway-runtime", () => {
  const store = new Map<string, string>(); // sessionKey -> assistant text
  const failRuns = new Map<string, true>(); // runId -> simulated failure
  let n = 0;
  return {
    callGatewayFromCli: async (method: string, _opts: unknown, params: Record<string, unknown>) => {
      if (method === "agent") {
        const runId = `r${(n += 1)}`;
        // A message containing "FAIL" simulates a sub-agent that errors with no text.
        if (String(params.message).includes("FAIL")) failRuns.set(runId, true);
        else store.set(String(params.sessionKey), `echo:${String(params.message)}`);
        return { runId };
      }
      if (method === "agent.wait") {
        return failRuns.has(String(params.runId))
          ? { status: "error", error: "simulated timeout" }
          : { status: "ok" };
      }
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

  it("surfaces sub-agent failure reasons even when the result is a NESTED object of nulls", async () => {
    const tool = createWorkflowTool();
    const ctx = {
      api: { config: { gateway: { port: 18790, auth: { token: "t" } } } },
      toolCallId: "call-2",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const result = await tool.execute(
      { script: `return { a: await agent("FAIL one"), b: await agent("FAIL two") };` },
      {},
      ctx,
    );
    // The script's own value is {a:null,b:null} — finalize must attach the reasons so
    // the caller isn't left guessing about a bare null.
    expect(result).toMatchObject({ result: { a: null, b: null } });
    expect(JSON.stringify(result)).toContain("sub-agent(s) failed");
    expect(JSON.stringify(result)).toContain("simulated timeout");
  });

  it("exposes the tool's static metadata", () => {
    const tool = createWorkflowTool();
    expect(tool.name).toBe("workflow");
    expect(typeof tool.execute).toBe("function");
    expect(tool.parameters).toBeDefined();
  });
});
