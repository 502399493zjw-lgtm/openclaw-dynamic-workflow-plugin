// L1 live schema proof. Gated behind OPENCLAW_LIVE_TEST=1.
//
// Drives the REAL runWorkflow engine against the isolated dev gateway via the
// same gateway-RPC SubagentRuntime adapter as the spine/runtime live tests.
// PASS proves that `agent(prompt, { schema })` returns a REAL sub-agent's output
// as a SCHEMA-VALIDATED object (parsed + TypeBox-checked, with retry on
// mismatch via runWithSchema) when a schemaValidatorFactory is wired into
// runWorkflow.
//
// Scripts run in a locked-down VM sandbox and cannot `import` anything, so the
// TypeBox schema is built HERE (in the test) and passed INTO the script through
// `args.schema`; the script then calls `agent(prompt, { schema: args.schema })`.
import { describe, it, expect } from "vitest";
import { Type } from "typebox";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { runWorkflow } from "../runtime/workflow-runtime.js";
import { typeboxValidator } from "../runtime/typebox-validator.js";
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
          idempotencyKey: `wf-schema:${p.sessionKey}:${Date.now()}`,
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

describe.skipIf(!live)("workflow schema (live)", () => {
  it("returns a single real sub-agent's output as a schema-validated object", async () => {
    const schema = Type.Object({ answer: Type.Number() });
    const result = (await runWorkflow({
      script: `
        return await agent(
          'Compute 6 * 7. Return ONLY compact JSON: {"answer": <number>}. No prose.',
          { schema: args.schema },
        );`,
      args: { schema },
      subagent: gatewaySubagent(),
      baseSessionKey: `agent:main:subagent:schema-live-${Date.now()}`,
      concurrency: 4,
      schemaValidatorFactory: (s) => typeboxValidator(s as never),
    })) as { answer: number } | null;

    expect(result).not.toBeNull();
    expect(typeof result?.answer).toBe("number");
    expect(result?.answer).toBe(42);
  }, 240_000);

  it("returns three parallel real sub-agents' outputs as schema-validated objects", async () => {
    const schema = Type.Object({ label: Type.String(), len: Type.Number() });
    const result = (await runWorkflow({
      script: `
        const words = ["alpha", "beta", "gamma"];
        return await parallel(
          words.map((w) => () =>
            agent(
              'Return ONLY JSON {"label":"<word>","len":<character count>} for the word: ' + w,
              { schema: args.schema },
            )),
        );`,
      args: { schema },
      subagent: gatewaySubagent(),
      baseSessionKey: `agent:main:subagent:schema-live-${Date.now()}`,
      concurrency: 4,
      schemaValidatorFactory: (s) => typeboxValidator(s as never),
    })) as Array<{ label: string; len: number } | null>;

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(3);
    for (const obj of result) {
      expect(obj).not.toBeNull();
      expect(typeof obj?.label).toBe("string");
      expect(typeof obj?.len).toBe("number");
      expect(obj!.len).toBeGreaterThan(0);
    }
    const labels = new Set(result.map((o) => o!.label.trim().toLowerCase()));
    expect(labels).toEqual(new Set(["alpha", "beta", "gamma"]));
  }, 240_000);
});
