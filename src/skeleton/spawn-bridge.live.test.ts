// L1 live spine proof (Plan #1 Task 0.7). Gated behind OPENCLAW_LIVE_TEST=1.
//
// Out-of-process there is no injected `api.runtime.subagent`, so this test
// builds a SubagentRuntime adapter backed by authenticated gateway RPCs
// (callGatewayFromCli → "agent" / "agent.wait" / "chat.history") and drives the
// REAL spawn-bridge code path. PASS proves: one sub-session spawned, awaited in
// code, and returned PONG via the spine.
import { describe, it, expect } from "vitest";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { spawnAwaitCollect, type SubagentRuntime } from "./spawn-bridge.js";

const live = process.env.OPENCLAW_LIVE_TEST === "1";
const url = process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:18789";

// Map the narrow SubagentRuntime surface onto real gateway RPCs so the exact
// spawn-bridge code path is exercised against the live gateway.
function gatewaySubagentRuntime(): SubagentRuntime {
  const opts = { url, json: true };
  return {
    run: async (params) => {
      const res = await callGatewayFromCli(
        "agent",
        opts,
        { lane: "subagent", message: params.message, deliver: params.deliver ?? false },
        { clientName: "cli", expectFinal: true },
      );
      return res as unknown as { runId: string };
    },
    waitForRun: async (params) => {
      const res = await callGatewayFromCli(
        "agent.wait",
        opts,
        { runId: params.runId, timeoutMs: params.timeoutMs },
        { clientName: "cli", expectFinal: true },
      );
      return res as unknown as { status: "ok" | "error" | "timeout"; error?: string };
    },
    getSessionMessages: async (params) => {
      const res = await callGatewayFromCli(
        "chat.history",
        opts,
        { key: params.sessionKey, limit: params.limit },
        { clientName: "cli", expectFinal: true },
      );
      return res as unknown as { messages: unknown[] };
    },
  };
}

describe.skipIf(!live)("spawnAwaitCollect (live)", () => {
  it("spawns one child, awaits in-code, and collects its output", async () => {
    const subagent = gatewaySubagentRuntime();
    const sessionKey = `agent:main:subagent:wf-live-${Date.now()}`;
    const { status, output } = await spawnAwaitCollect(
      subagent,
      sessionKey,
      "Reply with exactly the word: PONG",
    );
    expect(status).toBe("ok");
    expect(output.toUpperCase()).toContain("PONG");
  }, 180_000);
});
