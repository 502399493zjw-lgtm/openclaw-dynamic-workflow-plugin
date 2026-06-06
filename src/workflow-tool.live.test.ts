// L1 live runtime proof (Plan #2 Task 2.4). Gated behind OPENCLAW_LIVE_TEST=1.
//
// Drives the REAL runWorkflow engine against the isolated 2026.6.1 dev gateway
// (port 18790) via the same gateway-RPC SubagentRuntime adapter as the spine
// test. PASS proves the runtime orchestrates real OpenClaw sub-agents end-to-end
// (parallel fan-out, in-code await, result collection).
import { describe, it, expect } from "vitest";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { runWorkflow } from "./runtime/workflow-runtime.js";
import type { SubagentRuntime } from "./skeleton/spawn-bridge.js";

const live = process.env.OPENCLAW_LIVE_TEST === "1";
const url = process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:18790";
const token = process.env.OPENCLAW_GATEWAY_TOKEN || undefined;

function gatewaySubagent(): SubagentRuntime {
  const opts = { url, token, json: true };
  return {
    run: async (p) =>
      (await callGatewayFromCli(
        "agent",
        opts,
        {
          lane: "subagent",
          message: p.message,
          deliver: p.deliver ?? false,
          sessionKey: p.sessionKey,
          idempotencyKey: `wf2:${p.sessionKey}:${Date.now()}`,
        },
        { clientName: "cli", expectFinal: true },
      )) as unknown as { runId: string },
    waitForRun: async (p) =>
      (await callGatewayFromCli(
        "agent.wait",
        opts,
        { runId: p.runId, timeoutMs: p.timeoutMs },
        { clientName: "cli", expectFinal: true },
      )) as unknown as { status: "ok" | "error" | "timeout"; error?: string },
    getSessionMessages: async (p) =>
      (await callGatewayFromCli(
        "chat.history",
        opts,
        { sessionKey: p.sessionKey, limit: p.limit },
        { clientName: "cli", expectFinal: true },
      )) as unknown as { messages: unknown[] },
  };
}

describe.skipIf(!live)("workflow runtime (live)", () => {
  it("fans out two real sub-agents in parallel and collects both results", async () => {
    const result = (await runWorkflow({
      script: `
        phase("fanout");
        const rs = await parallel([
          () => agent("Reply with exactly: ALPHA"),
          () => agent("Reply with exactly: BETA"),
        ]);
        return rs;`,
      subagent: gatewaySubagent(),
      baseSessionKey: `agent:main:subagent:wf2-live-${Date.now()}`,
      concurrency: 4,
    })) as string[];
    const joined = result.join(" ").toUpperCase();
    expect(joined).toContain("ALPHA");
    expect(joined).toContain("BETA");
  }, 240_000);
});
