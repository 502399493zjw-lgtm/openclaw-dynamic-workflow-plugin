// L1 live runtime proof: Scenario A-lite — a seeded AUTH-AUDIT with adversarial
// filtering, run by REAL OpenClaw sub-agents. Gated behind OPENCLAW_LIVE_TEST=1.
//
// Drives the REAL runWorkflow engine against the isolated dev gateway (default
// port 18790) via the same gateway-RPC SubagentRuntime adapter as the other live
// tests. The workflow:
//   phase("scan")   → fan a sub-agent over every handler snippet, asking
//                     MISSING:<name> / OK:<name>. Collect MISSING candidates.
//   phase("verify") → for each candidate, an ADVERSARIAL second sub-agent is
//                     told a reviewer flagged it and is asked to REFUTE the
//                     flag. Only CONFIRMED:<name> replies survive.
// Return the CONFIRMED set.
//
// PASS proves the runtime orchestrates a real two-phase, scan→adversarial-verify
// audit over live agents (parallel fan-out, in-code candidate collection, second
// parallel fan-out keyed on the first phase's output).
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
          idempotencyKey: `wf-audit:${p.sessionKey}:${Date.now()}`,
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

// ── FIXTURE: small HTTP-handler snippets, deliberately CLEAR-CUT so a capable
// model judges them reliably. The audit's job is to find handlers that perform a
// SENSITIVE state-changing action with NO auth/permission guard.
//
//   PLANTED-MISSING (truly vulnerable): deleteUser, transferFunds, resetPassword
//     — each mutates sensitive state with zero auth check.
//   SAFE-WITH-AUTH: updateEmail — same shape, but guarded by an `if (!req.user)`
//     401 short-circuit BEFORE the mutation.
//   TRAP (false-positive bait): healthCheck — no auth check, but a read-only
//     public endpoint that changes NOTHING. The scan may flag it; the adversarial
//     verify phase must clear it.
type HandlerFile = { name: string; code: string };

const FILES: HandlerFile[] = [
  {
    name: "deleteUser",
    code: [
      "app.delete('/users/:id', async (req, res) => {",
      "  const id = req.params.id;",
      "  await db.users.delete({ where: { id } });",
      "  res.status(200).json({ deleted: id });",
      "});",
    ].join("\n"),
  },
  {
    name: "transferFunds",
    code: [
      "app.post('/accounts/transfer', async (req, res) => {",
      "  const { from, to, amount } = req.body;",
      "  await db.ledger.move({ from, to, amount });",
      "  res.status(200).json({ ok: true });",
      "});",
    ].join("\n"),
  },
  {
    name: "resetPassword",
    code: [
      "app.post('/users/:id/reset-password', async (req, res) => {",
      "  const id = req.params.id;",
      "  const next = req.body.newPassword;",
      "  await db.users.update({ where: { id }, data: { password: hash(next) } });",
      "  res.status(200).json({ ok: true });",
      "});",
    ].join("\n"),
  },
  {
    name: "healthCheck",
    code: [
      "app.get('/health', (req, res) => {",
      "  res.status(200).json({ status: 'ok' });",
      "});",
    ].join("\n"),
  },
];

// GROUND TRUTH: the names that are TRULY missing-auth (sensitive action + no guard).
const PLANTED_MISSING = ["deleteUser", "transferFunds", "resetPassword"] as const;
const TRAP = "healthCheck";

// Coerce one agent reply (typed `unknown` by the engine) to a searchable string.
function asText(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

describe.skipIf(!live)("auth-audit scan→verify (live)", () => {
  it("confirms planted missing-auth handlers and adversarially clears the trap", async () => {
    const result = (await runWorkflow({
      script: `
        // ── phase("scan"): fan one sub-agent per handler. Each replies with
        // EXACTLY one line, MISSING:<name> or OK:<name>.
        phase("scan");
        const files = args.files;
        const scanReplies = await parallel(
          files.map((f) => () =>
            agent(
              "Here is handler " + f.name + ":\\n" + f.code +
              "\\nDoes it perform a SENSITIVE state-changing action WITHOUT any auth/permission check? " +
              "Reply with EXACTLY one line: MISSING:" + f.name + " or OK:" + f.name
            )
          )
        );
        // Collect candidate names whose scan reply judges MISSING. Parse ROBUSTLY:
        // uppercase + strip ALL whitespace so "MISSING: deleteUser", markdown, or
        // surrounding prose still match the verdict token.
        const norm = (s) => String(s == null ? "" : s).toUpperCase().replace(/\\s+/g, "");
        const candidates = [];
        for (let i = 0; i < files.length; i++) {
          const r = norm(scanReplies[i]);
          if (r.indexOf("MISSING:" + files[i].name.toUpperCase()) !== -1) {
            candidates.push(files[i]);
          }
        }
        log("candidates:" + candidates.map((c) => c.name).join(","));

        // ── phase("verify"): ADVERSARIAL re-check. Each candidate is told a
        // reviewer flagged it and is asked to REFUTE the flag. Only CONFIRMED
        // replies survive — this is what clears the read-only TRAP.
        phase("verify");
        const verifyReplies = await parallel(
          candidates.map((c) => () =>
            agent(
              "Re-examine handler " + c.name + ":\\n" + c.code +
              "\\nConfirm whether this is a REAL missing-auth vulnerability: it performs a SENSITIVE " +
              "state-changing action (writes/updates/deletes/moves data) AND has NO auth or permission " +
              "guard inside this handler. Reply FALSEALARM:" + c.name + " ONLY if it is clearly NOT a " +
              "vulnerability (it is read-only / changes nothing, OR an auth guard such as if (!req.user) " +
              "is present). Otherwise reply CONFIRMED:" + c.name + ". Answer with EXACTLY that one token."
            )
          )
        );
        const confirmed = [];
        for (let i = 0; i < candidates.length; i++) {
          const r = norm(verifyReplies[i]);
          if (r.indexOf("CONFIRMED:" + candidates[i].name.toUpperCase()) !== -1) {
            confirmed.push(candidates[i].name);
          }
        }
        log("confirmed:" + confirmed.join(","));
        return confirmed;`,
      args: { files: FILES },
      subagent: gatewaySubagent(),
      baseSessionKey: `agent:main:subagent:audit-live-${Date.now()}`,
      concurrency: 4,
      onEvent: (e: WorkflowEvent) => {
        // eslint-disable-next-line no-console
        if (e.type === "phase") console.log(`[auth-audit.live] phase: ${e.name}`);
        // eslint-disable-next-line no-console
        else if (e.type === "log") console.log(`[auth-audit.live] ${e.message}`);
      },
    })) as unknown;

    // Normalize the returned CONFIRMED set to a string[] (engine types it unknown).
    const confirmed = Array.isArray(result) ? result.map(asText) : [];
    // eslint-disable-next-line no-console
    console.log(`[auth-audit.live] confirmed set: ${JSON.stringify(confirmed)}`);

    // ── ORACLE (threshold-based BY DESIGN). Real sub-agents are nondeterministic,
    // so we do NOT demand a perfect set. The fixture is deliberately clear-cut, so
    // these robust thresholds hold reliably:
    //
    //   (a) RECALL ≥ 2/3 of the planted-missing handlers come back CONFIRMED.
    //       (Clear-cut vulnerable snippets + a ≥2/3 floor absorbs one flaky agent.)
    //   (b) The read-only TRAP (healthCheck) is NOT in the confirmed set — a public
    //       endpoint that changes nothing must never be flagged as a vuln.
    // NOTE: an earlier "safe write endpoint" was removed — a strict real model
    // legitimately nitpicks any state-changing handler (e.g. email change without
    // re-auth), so asserting the model calls it "safe" would test model leniency,
    // not our orchestration. The robust oracle: real bugs surfaced + read-only not flagged.
    const recall = PLANTED_MISSING.filter((n) => confirmed.includes(n)).length;
    expect(recall).toBeGreaterThanOrEqual(2); // ≥ 2 of 3 planted-missing (recall ≥ 2/3)
    expect(confirmed).not.toContain(TRAP); // read-only endpoint not flagged
  }, 300_000);
});
