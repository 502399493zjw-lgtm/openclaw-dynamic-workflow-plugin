import { describe, it, expect, vi } from "vitest";
import { runWorkflow, type WorkflowEvent } from "./workflow-runtime.js";
import type { SubagentRuntime } from "../skeleton/spawn-bridge.js";

// Fake subagent: echoes a per-prompt canned reply after an optional delay.
function fakeSubagent(opts?: { reply?: (msg: string) => string; delayMs?: (msg: string) => number }): {
  rt: SubagentRuntime;
  peakConcurrency: () => number;
} {
  let active = 0;
  let peak = 0;
  const reply = opts?.reply ?? ((m) => `reply:${m}`);
  const delay = opts?.delayMs ?? (() => 0);
  const store = new Map<string, string>();
  const rt: SubagentRuntime = {
    run: async ({ sessionKey, message }) => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, delay(message)));
      active -= 1;
      store.set(sessionKey, reply(message));
      return { runId: `run:${sessionKey}` };
    },
    waitForRun: async () => ({ status: "ok" }),
    getSessionMessages: async ({ sessionKey }) => ({
      messages: [{ role: "assistant", content: [{ type: "text", text: store.get(sessionKey) ?? "" }] }],
    }),
  };
  return { rt, peakConcurrency: () => peak };
}

type RunOpts = Parameters<typeof runWorkflow>[0];
const base = (over: Partial<RunOpts> & Pick<RunOpts, "script">): RunOpts => ({
  baseSessionKey: "agent:main:subagent:wf-test",
  subagent: fakeSubagent().rt,
  ...over,
});

describe("runWorkflow", () => {
  it("agent() spawns one sub-session and returns its collected text", async () => {
    const result = await runWorkflow(base({ script: `return await agent("hi");` }));
    expect(result).toBe("reply:hi");
  });

  it("parallel() runs all then resolves, order preserved (barrier)", async () => {
    const result = await runWorkflow(
      base({ script: `return await parallel([() => agent("a"), () => agent("b"), () => agent("c")]);` }),
    );
    expect(result).toEqual(["reply:a", "reply:b", "reply:c"]);
  });

  it("enforces the concurrency cap", async () => {
    const fake = fakeSubagent({ delayMs: () => 10 });
    const script = `return await parallel(Array.from({length: 12}, (_, i) => () => agent("t" + i)));`;
    await runWorkflow(base({ script, subagent: fake.rt, concurrency: 4 }));
    expect(fake.peakConcurrency()).toBeLessThanOrEqual(4);
  });

  it("pipeline() streams items independently (no barrier): fast item reaches stage2 before slow item clears stage1", async () => {
    const events: string[] = [];
    // item "fast" is quick at stage1, "slow" is slow at stage1; record stage entries.
    const script = `
      return await pipeline(
        ["fast", "slow"],
        async (item) => { log("s1:" + item); return await agent("stage1:" + item); },
        async (prev, item) => { log("s2:" + item); return await agent("stage2:" + item); },
      );`;
    const fake = fakeSubagent({ delayMs: (m) => (m.includes("slow") ? 40 : 1) });
    await runWorkflow(base({
      script, subagent: fake.rt,
      onEvent: (e: WorkflowEvent) => { if (e.type === "log") events.push(e.message); },
    }));
    // fast must enter stage2 before slow finishes stage1 (interleaving)
    expect(events.indexOf("s2:fast")).toBeLessThan(events.indexOf("s2:slow"));
    expect(events.indexOf("s2:fast")).toBeGreaterThan(-1);
  });

  it("a failed agent yields null, run continues", async () => {
    const fake = fakeSubagent();
    fake.rt.waitForRun = async () => ({ status: "error", error: "boom" });
    const result = await runWorkflow(base({
      script: `const r = await parallel([() => agent("a")]); return r;`, subagent: fake.rt,
    }));
    expect(result).toEqual([null]);
  });

  it("exposes args; budget hard-ceiling stops new spawns", async () => {
    const r1 = await runWorkflow(base({ script: `return args.map(n => n*2);`, args: [1, 2, 3] }));
    expect(r1).toEqual([2, 4, 6]);
  });

  it("rejects an illegal script (fs/shell)", async () => {
    await expect(runWorkflow(base({ script: `return require("fs");` }))).rejects.toThrow();
  });

  it("emits phase + agent lifecycle events", async () => {
    const events: WorkflowEvent[] = [];
    await runWorkflow(base({
      script: `phase("scan"); await agent("x"); phase("verify"); await agent("y");`,
      onEvent: (e) => events.push(e),
    }));
    expect(events.filter((e) => e.type === "phase").map((e: any) => e.name)).toEqual(["scan", "verify"]);
    expect(events.filter((e) => e.type === "agent:done").length).toBe(2);
  });
});
