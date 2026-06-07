// A SubagentRuntime backed by a self-connecting GatewayClient (callGatewayFromCli).
//
// WHY: `api.runtime.subagent` is bound to the gateway-request AsyncLocalStorage
// scope (api-findings §13), which our node:vm sandbox + deferred scheduler drop —
// so in-gateway spawns throw "only available during a gateway request". A fresh
// gateway client connection does NOT depend on that scope. This is the exact
// agent / agent.wait / chat.history mechanism the live tests prove; the in-gateway
// tool now uses it against its own loopback gateway (port + token from config).
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import type { SubagentRuntime, SpawnRunOptions } from "./spawn-bridge.js";

export type GatewaySubagentConn = {
  /** ws://127.0.0.1:<port> of the gateway to connect to. */
  url: string;
  /** Operator token for the gateway (config.gateway.auth.token). */
  token?: string;
  /** Prefix for the required-unique idempotencyKey. */
  idempotencyPrefix?: string;
  /** Extra operator scopes to request (e.g. ["operator.admin"] to authorize model override). */
  scopes?: ("operator.admin")[];
};

// Each agent RPC needs a unique idempotencyKey; a monotonic counter avoids Date.now()
// (banned in workflow scripts; this module is plugin code, but a counter is simplest).
let idempotencySeq = 0;

export function createGatewaySubagent(conn: GatewaySubagentConn): SubagentRuntime {
  const opts = { url: conn.url, token: conn.token, json: true };
  const extra = {
    clientName: "cli" as const,
    expectFinal: true,
    ...(conn.scopes ? { scopes: conn.scopes } : {}),
  };
  const prefix = conn.idempotencyPrefix ?? "wf";

  return {
    run: async (p: {
      sessionKey: string;
      message: string;
      deliver?: boolean;
    } & SpawnRunOptions) => {
      idempotencySeq += 1;
      return (await callGatewayFromCli(
        "agent",
        opts,
        {
          lane: "subagent",
          message: p.message,
          deliver: p.deliver ?? false,
          sessionKey: p.sessionKey,
          idempotencyKey: `${prefix}:${p.sessionKey}:${idempotencySeq}`,
          ...(p.model !== undefined ? { model: p.model } : {}),
          ...(p.provider !== undefined ? { provider: p.provider } : {}),
          ...(p.extraSystemPrompt !== undefined ? { extraSystemPrompt: p.extraSystemPrompt } : {}),
        },
        extra,
      )) as unknown as { runId: string };
    },
    waitForRun: async (p) =>
      (await callGatewayFromCli(
        "agent.wait",
        opts,
        { runId: p.runId, timeoutMs: p.timeoutMs },
        extra,
      )) as unknown as { status: "ok" | "error" | "timeout"; error?: string },
    getSessionMessages: async (p) =>
      (await callGatewayFromCli(
        "chat.history",
        opts,
        { sessionKey: p.sessionKey, limit: p.limit },
        extra,
      )) as unknown as { messages: unknown[] },
  };
}
