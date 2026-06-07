import { describe, it, expect, vi } from "vitest";
import { runWorkflow, type WorkflowEvent } from "./workflow-runtime.js";
import { createResumeJournal } from "./resume-journal.js";
import type { SubagentRuntime } from "../skeleton/spawn-bridge.js";

// The full param shape `subagent.run` receives, captured for assertions.
type RunParams = Parameters<SubagentRuntime["run"]>[0];

// Fake subagent: echoes a per-prompt canned reply after an optional delay.
function fakeSubagent(opts?: { reply?: (msg: string) => string; delayMs?: (msg: string) => number }): {
  rt: SubagentRuntime;
  peakConcurrency: () => number;
  spawnCount: () => number;
  lastRunParams: () => RunParams | undefined;
  runParams: () => RunParams[];
} {
  let active = 0;
  let peak = 0;
  let spawns = 0;
  const reply = opts?.reply ?? ((m) => `reply:${m}`);
  const delay = opts?.delayMs ?? (() => 0);
  const store = new Map<string, string>();
  const captured: RunParams[] = [];
  const rt: SubagentRuntime = {
    run: async (params) => {
      captured.push(params);
      const { sessionKey, message } = params;
      spawns += 1;
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
  return {
    rt,
    peakConcurrency: () => peak,
    spawnCount: () => spawns,
    lastRunParams: () => captured[captured.length - 1],
    runParams: () => captured,
  };
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

  it("agent() threads model/provider/system into subagent.run (system → extraSystemPrompt)", async () => {
    const fake = fakeSubagent();
    await runWorkflow(
      base({
        script: `return await agent("hi", { model: "m1", provider: "p1", system: "be terse" });`,
        subagent: fake.rt,
      }),
    );
    const params = fake.lastRunParams();
    expect(params).toMatchObject({
      message: "hi",
      model: "m1",
      provider: "p1",
      extraSystemPrompt: "be terse",
    });
  });

  it("agent({timeout}) threads seconds into the spawn as rpcTimeoutMs (ms)", async () => {
    const fake = fakeSubagent();
    await runWorkflow(base({ script: `return await agent("hi", { timeout: 60 });`, subagent: fake.rt }));
    expect(fake.lastRunParams()).toMatchObject({ rpcTimeoutMs: 60000 });
  });

  it("agent() with no overrides omits model/provider/extraSystemPrompt (default behavior)", async () => {
    const fake = fakeSubagent();
    await runWorkflow(base({ script: `return await agent("hi");`, subagent: fake.rt }));
    const params = fake.lastRunParams()!;
    expect(params.model).toBeUndefined();
    expect(params.provider).toBeUndefined();
    expect(params.extraSystemPrompt).toBeUndefined();
    expect("model" in params).toBe(false);
    expect("provider" in params).toBe(false);
    expect("extraSystemPrompt" in params).toBe(false);
  });

  it("parallel() runs all then resolves, order preserved (barrier)", async () => {
    const result = await runWorkflow(
      base({ script: `return await parallel([() => agent("a"), () => agent("b"), () => agent("c")]);` }),
    );
    expect(result).toEqual(["reply:a", "reply:b", "reply:c"]);
  });

  it("parallel() also accepts varargs (LLM-natural parallel(t1, t2), not just an array)", async () => {
    const result = await runWorkflow(
      base({ script: `return await parallel(() => agent("a"), () => agent("b"));` }),
    );
    expect(result).toEqual(["reply:a", "reply:b"]);
  });

  it("parallel() throws an actionable error when given a non-function", async () => {
    await expect(
      runWorkflow(base({ script: `return await parallel(agent("a"));` })),
    ).rejects.toThrow(/parallel\(\) expects thunks/);
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

  it("a failed agent with no output yields null, run continues", async () => {
    const fake = fakeSubagent();
    fake.rt.waitForRun = async () => ({ status: "error", error: "boom" });
    // A run that errored before producing any assistant text → no text to keep.
    fake.rt.getSessionMessages = async () => ({ messages: [] });
    const result = await runWorkflow(base({
      script: `const r = await parallel([() => agent("a")]); return r;`, subagent: fake.rt,
    }));
    expect(result).toEqual([null]);
  });

  it("a non-ok status still RETURNS collected text (don't discard a partial answer)", async () => {
    const fake = fakeSubagent();
    // The run ends non-ok (e.g. a soft timeout) but the agent already produced a
    // final answer — that text must survive, not be dropped to null.
    fake.rt.waitForRun = async () => ({ status: "timeout" });
    const result = await runWorkflow(base({
      script: `return await agent("a");`, subagent: fake.rt,
    }));
    expect(result).toBe("reply:a");
  });

  it("propagates the gateway failure reason on a no-text spawn (agent:done.error)", async () => {
    const fake = fakeSubagent();
    fake.rt.waitForRun = async () => ({ status: "error", error: "billing error: key out of credits" });
    fake.rt.getSessionMessages = async () => ({ messages: [] }); // errored, no assistant text
    const events: WorkflowEvent[] = [];
    const result = await runWorkflow(
      base({ script: `return await agent("a");`, subagent: fake.rt, onEvent: (e) => events.push(e) }),
    );
    expect(result).toBeNull();
    const done = events.find((e) => e.type === "agent:done") as { error?: string } | undefined;
    expect(done?.error).toContain("billing error");
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

  it("resume: a pre-populated journal makes a re-run spawn 0 sub-agents (§3.5)", async () => {
    // Shared backing store survives across the two runs (mirrors a managedFlow
    // stateJson slot). The journal keys by `{callSite, prompt}` via agentCacheKey.
    const store: Record<string, unknown> = {};
    const journalFor = () =>
      createResumeJournal({
        read: async () => store,
        write: async (entries) => {
          Object.assign(store, entries);
        },
        scriptHash: "h-resume",
        args: { a: 1 },
      });
    const script = `phase("scan"); const a = await agent("audit A"); phase("verify"); const b = await agent("verify B"); return [a, b];`;

    // First run: populates the journal; assert two real spawns occurred.
    const first = fakeSubagent();
    const r1 = await runWorkflow(
      base({ script, args: { a: 1 }, subagent: first.rt, journal: journalFor() }),
    );
    expect(first.spawnCount()).toBe(2);
    expect(r1).toEqual(["reply:audit A", "reply:verify B"]);

    // Re-run with the populated store + a fresh counting subagent: 0 spawns,
    // identical results returned straight from the journal.
    const second = fakeSubagent();
    const events: WorkflowEvent[] = [];
    const r2 = await runWorkflow(
      base({
        script,
        args: { a: 1 },
        subagent: second.rt,
        journal: journalFor(),
        onEvent: (e) => events.push(e),
      }),
    );
    expect(second.spawnCount()).toBe(0);
    expect(r2).toEqual(["reply:audit A", "reply:verify B"]);
    // Both agents resolved from cache.
    expect(events.filter((e) => e.type === "agent:done" && (e as any).status === "cached").length).toBe(2);
  });
});
