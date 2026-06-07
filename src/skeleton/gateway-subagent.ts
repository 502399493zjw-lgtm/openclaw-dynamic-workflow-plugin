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

// The gateway RPC client times out the FIRST-RESPONSE window of each call after
// `opts.timeout` ms (SDK default DEFAULT_GATEWAY_RPC_TIMEOUT_MS = 10_000). 10s is fine
// for interactive CLI calls but too tight for a sub-agent spawn, which runs a full
// agent turn (reasoning + tools + web) and can take minutes just to START streaming
// under load — in a big fan-out the late agents queue for a concurrency slot on a
// rate-limited key. The original 10s hit was the mysterious research-`null` (every
// child: "gateway timeout after 10000ms"). Once streaming starts this is an idle /
// inter-chunk window, NOT a total cap (the total is bounded separately by the gateway's
// agents.defaults.timeoutSeconds), so a generous default is safe. We default to 10 min
// to line up with that per-agent run budget. NOTE: the knob is `opts.timeout` (ms);
// earlier attempts set `timeoutMs`/`requestTimeoutMs`, which the SDK ignores.
const DEFAULT_SPAWN_RPC_TIMEOUT_MS = 600_000;

export function createGatewaySubagent(conn: GatewaySubagentConn): SubagentRuntime {
  // The SDK types opts.timeout as a string (it comes from the `--timeout` CLI flag) but
  // parses it as a millisecond integer at runtime, so pass the ms value stringified.
  const baseOpts = {
    url: conn.url,
    token: conn.token,
    json: true,
    timeout: String(DEFAULT_SPAWN_RPC_TIMEOUT_MS),
  };
  // A per-spawn override (from agent(prompt,{timeout})) replaces the default first-
  // response window for that one child; everything else keeps the 120s default.
  const optsFor = (rpcTimeoutMs?: number) =>
    rpcTimeoutMs !== undefined ? { ...baseOpts, timeout: String(rpcTimeoutMs) } : baseOpts;
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
        optsFor(p.rpcTimeoutMs),
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
        baseOpts,
        { runId: p.runId, timeoutMs: p.timeoutMs },
        extra,
      )) as unknown as { status: "ok" | "error" | "timeout"; error?: string },
    getSessionMessages: async (p) =>
      (await callGatewayFromCli(
        "chat.history",
        baseOpts,
        { sessionKey: p.sessionKey, limit: p.limit },
        extra,
      )) as unknown as { messages: unknown[] },
  };
}
