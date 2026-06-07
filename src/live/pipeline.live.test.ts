// L1 live runtime proof: real 2-stage pipeline() over real OpenClaw sub-agents.
// Gated behind OPENCLAW_LIVE_TEST=1.
//
// Drives the REAL runWorkflow engine against the isolated dev gateway (default
// port 18790) via the same gateway-RPC SubagentRuntime adapter as the spine
// test. PASS proves `pipeline()` drives each item through BOTH stages, in order,
// independently per item — i.e. real multi-stage execution against live agents.
//
// NOTE on ordering: the no-barrier interleaving semantics of pipeline() (stages
// of different items overlapping in time) are proven DETERMINISTICALLY in the
// unit test. Real-agent latency varies, so this live test does NOT hard-fail on
// observed s1/s2 interleaving — it only logs what it saw. The load-bearing
// oracle here is that every item reached and completed BOTH stages.
import { describe, it, expect } from "vitest";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { runWorkflow, type WorkflowEvent } from "../runtime/workflow-runtime.js";
import type { SubagentRuntime } from "../skeleton/spawn-bridge.js";

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
          idempotencyKey: `wf-pipe:${p.sessionKey}:${Date.now()}`,
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

describe.skipIf(!live)("pipeline (live)", () => {
  it("drives 3 items through both real stages independently", async () => {
    const logs: string[] = [];
    const result = (await runWorkflow({
      script: `
        phase("pipe");
        const out = await pipeline(
          ["A", "B", "C"],
          async (_prev, item) => {
            log("s1:" + item);
            return agent("Reply with EXACTLY this token and nothing else: stage1-" + item + "-ok");
          },
          async (prev, item) => {
            log("s2:" + item);
            return agent("Reply with EXACTLY this token and nothing else: stage2-" + item + "-ok");
          },
        );
        return out;`,
      subagent: gatewaySubagent(),
      baseSessionKey: `agent:main:subagent:pipe-live-${Date.now()}`,
      concurrency: 4,
      onEvent: (e: WorkflowEvent) => {
        if (e.type === "log") logs.push(e.message);
      },
    })) as string[];

    // ORACLE: 3 entries, one per item; each item's FINAL (stage-2) text contains
    // (case-insensitive) `stage2-<item>-ok`. Robust to real-agent chatter/casing.
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(3);
    for (const item of ["A", "B", "C"]) {
      const idx = ["A", "B", "C"].indexOf(item);
      const text = String(result[idx] ?? "").toLowerCase();
      expect(text).toContain(`stage2-${item}-ok`.toLowerCase());
    }

    // Observability only: report the observed s1/s2 ordering. We assert that
    // every item entered BOTH stages, but we do NOT assert interleaving timing
    // (real latency varies; barrier-free interleaving is proven in the unit test).
    for (const item of ["A", "B", "C"]) {
      expect(logs).toContain(`s1:${item}`);
      expect(logs).toContain(`s2:${item}`);
    }
    // eslint-disable-next-line no-console
    console.log(`[pipeline.live] observed log order: ${logs.join(" | ")}`);
  }, 240_000);
});
