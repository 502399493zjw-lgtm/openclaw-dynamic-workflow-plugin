// L1 live cross-check proof (spec Scenario B-lite). Gated behind OPENCLAW_LIVE_TEST=1.
//
// Drives the REAL runWorkflow engine against the isolated dev gateway (default
// port 18790) via the same gateway-RPC SubagentRuntime adapter as the other
// live tests. PASS proves that real OpenClaw sub-agents perform a TWO-PHASE
// cross-checked synthesis: (1) a parallel extract phase, one real sub-agent per
// source, pulls each source's claimed fact; (2) a single synthesis sub-agent
// resolves the consensus by MAJORITY cross-check and flags the contradicting
// outlier.
//
// WHY A PLANTED CONTRADICTION + A FICTIONAL FACT: the fact below ("Zephyr 2.0"
// config format) is made up, so the model has NO training-data prior to lean on.
// Two sources agree (TOML) and one contradicts (JSON). The only way to land on
// TOML and finger S3 is to actually read the three claims and vote — i.e. real
// cross-check, not recall. This is the load-bearing reason the oracle works.
//
// Scripts run in a locked-down VM sandbox and cannot `import` anything, so the
// three inline sources are built HERE (in the test) and passed INTO the script
// through `args.sources`.
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
          idempotencyKey: `wf-xcheck:${p.sessionKey}:${Date.now()}`,
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

// ─── Inline sources + ground truth ──────────────────────────────────────────
// Three "sources" about a MADE-UP fact: the config format of the fictional tool
// "Zephyr" in v2.0. Two agree (TOML), one contradicts (JSON). No web, no recall.
type Source = { id: string; text: string };

const SOURCES: Source[] = [
  {
    id: "S1",
    text:
      "Release notes: Zephyr 2.0 migrated its config format to TOML, dropping the " +
      "legacy INI files used through the 1.x line. All examples in the 2.0 guide " +
      "now ship as .toml.",
  },
  {
    id: "S2",
    text:
      "Migration FAQ: As of 2.0, Zephyr configs are written in TOML. If you are " +
      "upgrading from 1.x, run `zephyr migrate` to convert your old config into the " +
      "new TOML layout.",
  },
  {
    id: "S3",
    text:
      "Community blog post: Zephyr 2.0 switched its config format to JSON, so you " +
      "should rewrite your settings file as a .json document before upgrading.",
  },
];

// Ground truth: majority of sources say TOML; the lone outlier is S3 (it says JSON).
const GROUND_TRUTH_CONSENSUS = "TOML";
const GROUND_TRUTH_OUTLIER_ID = "S3";

describe.skipIf(!live)("cross-check synthesis (live)", () => {
  it("resolves consensus by majority and flags the contradicting outlier", async () => {
    const result = (await runWorkflow({
      script: `
        // PHASE 1 — extract: one real sub-agent per source, fanned out in parallel.
        phase("extract");
        const claims = await parallel(
          args.sources.map((s) => () =>
            agent(
              "Source [" + s.id + "]:\\n" + s.text +
                "\\nIn ONE line, state ONLY what config format this source says " +
                "Zephyr 2.0 uses. Format: " + s.id + "=<FORMAT>",
            )),
        );

        // PHASE 2 — crosscheck: a single synthesis sub-agent votes over all 3 claims.
        phase("crosscheck");
        return await agent(
          "Three sources each state Zephyr 2.0's config format:\\n" +
            claims.join("\\n") +
            "\\nBy majority cross-check, what is the consensus format, and which " +
            "source id is the contradicting outlier? Reply EXACTLY two lines:\\n" +
            "CONSENSUS=<FORMAT>\\nOUTLIER=<source id>",
        );`,
      args: { sources: SOURCES },
      subagent: gatewaySubagent(),
      baseSessionKey: `agent:main:subagent:xcheck-live-${Date.now()}`,
      concurrency: 4,
    })) as unknown;

    // Narrow the (unknown) final agent output to text before asserting on it.
    const finalText = typeof result === "string" ? result : String(result ?? "");
    const upper = finalText.toUpperCase();

    // ORACLE (robust). This proves real cross-check VOTING filtered the single
    // contradicted claim: a model that ignored the sources and guessed, or that
    // got swayed by the lone JSON outlier, would fail here.
    //
    // Primary asserts, kept lenient against real-agent chatter/casing:
    //   1. The consensus mentions TOML (the majority format)...
    expect(upper).toContain(GROUND_TRUTH_CONSENSUS); // "TOML"
    //   2. ...and the consensus is NOT JSON (the outlier's claim was rejected).
    expect(upper).not.toContain("CONSENSUS=JSON");
    //   3. The named outlier is S3 (the JSON source). We anchor on the OUTLIER
    //      line so an incidental "JSON" mention elsewhere can't fool us.
    const outlierLine =
      finalText
        .split(/\r?\n/)
        .find((l) => /outlier/i.test(l)) ?? "";
    expect(outlierLine.toUpperCase()).toContain(GROUND_TRUTH_OUTLIER_ID); // "S3"
  }, 300_000);
});
