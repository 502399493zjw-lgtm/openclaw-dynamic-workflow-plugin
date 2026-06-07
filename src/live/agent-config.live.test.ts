// L1 live proof: per-agent CONFIG — a workflow agent() can set a sub-agent's
// PERSONA (system prompt) and MODEL. Gated behind OPENCLAW_LIVE_TEST=1.
//
// Unlike the other live adapters, this one FORWARDS p.model / p.provider /
// p.extraSystemPrompt to the gateway "agent" RPC (the SubagentRuntime params the
// runtime now threads from agent(prompt, { model, provider, system })).
// Model override needs the dev config's plugins.entries.workflows.subagent.
// allowModelOverride=true (already set in .devgateway).
import { describe, it, expect } from "vitest";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { runWorkflow } from "../runtime/workflow-runtime.js";
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
          idempotencyKey: `wf-cfg:${p.sessionKey}:${Date.now()}`,
          // forward the per-agent overrides the runtime threads through
          ...(p.model !== undefined ? { model: p.model } : {}),
          ...(p.provider !== undefined ? { provider: p.provider } : {}),
          ...(p.extraSystemPrompt !== undefined ? { extraSystemPrompt: p.extraSystemPrompt } : {}),
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

describe.skipIf(!live)("per-agent config (live)", () => {
  it("PERSONA: a custom system prompt changes the sub-agent's behavior", async () => {
    const out = (await runWorkflow({
      script: `return await agent("Say hello to the team.", { system: "You MUST reply in ALL UPPERCASE LETTERS, and end your entire reply with the exact word WOOF." });`,
      subagent: gatewaySubagent(),
      baseSessionKey: `agent:main:subagent:cfg-persona-${Date.now()}`,
    })) as string;
    // The persona forces uppercase + a WOOF sign-off — both checkable.
    expect(out).toContain("WOOF");
    // no lowercase ascii letters (the persona forced ALL CAPS)
    expect(/[a-z]/.test(out)).toBe(false);
  }, 180_000);

  it("MODEL: a per-agent model override is delivered to the gateway's authorization gate", async () => {
    // The runtime threads `model` (from agent(prompt,{model})) through subagent.run →
    // the gateway "agent" RPC. This OUT-OF-PROCESS caller's token lacks operator.admin,
    // so the gateway REJECTS the override with its model-override authorization error —
    // which proves the model param is delivered and evaluated end-to-end (NOT silently
    // dropped). A real run authorizes it the installed-plugin way, via
    // plugins.entries.workflows.subagent.allowModelOverride (sets client.internal.
    // allowModelOverride), or via an operator.admin-scoped caller. (Persona above proves
    // the same per-agent opts mechanism changes a child end-to-end when no extra auth is
    // needed.)
    const sub = gatewaySubagent();
    let err = "";
    try {
      await sub.run({
        sessionKey: `agent:main:subagent:cfg-model-probe-${Date.now()}`,
        message: "hi",
        model: "moonshot/kimi-k2.5",
        deliver: false,
      });
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    // The gateway's model-override authorization gate was reached and evaluated.
    expect(err.toLowerCase()).toContain("override");
  }, 120_000);
});
