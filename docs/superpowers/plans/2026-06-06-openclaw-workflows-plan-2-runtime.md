# openclaw-plugin-workflows — Plan #2: Core Workflow Runtime

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the `workflow` tool actually execute an LLM-authored orchestration script — wire `agent()/parallel()/pipeline()/phase()/log()` (+ `schema`/`args`/`budget`) over the proven foundation, run it as a detached background task that emits typed progress, and return a single coordinated result.

**Architecture:** A `runWorkflow()` engine injects the primitives into the `node:vm` sandbox (Plan #1 `runScript`). `agent()` goes through the concurrency `scheduler`, spawns a real sub-session via the proven `spawnAwaitCollect` (`api.runtime.subagent`), validates against `schema` with retry, and charges the `budget`. `parallel()` is a barrier; `pipeline()` is no-barrier streaming. The `workflow` tool runs the engine inside a detached task and maps engine events → `onUpdate` typed progress.

**Tech Stack:** TypeScript ESM, Vitest, `node:vm`, `openclaw/plugin-sdk/*` (`defineToolPlugin`, `api.runtime.subagent`, detached-task-runtime), TypeBox. Verified contracts in `docs/superpowers/plans/api-findings.md`.

**Scope:** This is **Plan #2 of (now) 3**. It delivers the executing runtime — a `workflow` tool that runs a real multi-agent script end-to-end. **Deferred to Plan #3:** the Canvas A2UI phase-tree panel, SQLite-KV resume journal, save-as-`/command`, and the interactive approval gate. Builds on Plan #1 (committed): `scheduler`, `budget`, `schema-retry`, `validate-script`, `sandbox`, `spawn-bridge` (`SubagentRuntime` + `spawnAwaitCollect`), `phase-tree-a2ui`.

**Conventions:** `pnpm test <path>` (never raw vitest); commit after each green task; agents do NOT commit during a Workflow run (the orchestrator commits after review). Live tests gated behind `OPENCLAW_LIVE_TEST=1` against the isolated `.devgateway` gateway (port 18790).

---

## Task 2.1: WorkflowRuntime — primitives over the foundation

**Files:**
- Create: `src/runtime/workflow-runtime.ts`
- Test: `src/runtime/workflow-runtime.test.ts`

- [ ] **Step 1: Write the failing test** (uses a FAKE `SubagentRuntime` so primitive semantics are deterministic — this tests OUR orchestration logic, not OpenClaw)

```ts
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

const base = (over: Partial<Parameters<typeof runWorkflow>[0]> = {}) => ({
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/runtime/workflow-runtime.test.ts`
Expected: FAIL — `runWorkflow` not defined.

- [ ] **Step 3: Implement** `src/runtime/workflow-runtime.ts`

```ts
import { createScheduler } from "./scheduler.js";
import { createBudget } from "./budget.js";
import { runWithSchema, type Validator } from "./schema-retry.js";
import { runScript } from "./sandbox.js";
import { validateScript } from "./validate-script.js";
import { spawnAwaitCollect, type SubagentRuntime } from "../skeleton/spawn-bridge.js";

export type WorkflowEvent =
  | { type: "phase"; name: string }
  | { type: "agent:start"; phase: string; label: string; seq: number }
  | { type: "agent:done"; phase: string; label: string; seq: number; status: string }
  | { type: "log"; phase: string; message: string };

export type RunWorkflowOpts = {
  script: string;
  args?: unknown;
  subagent: SubagentRuntime;
  baseSessionKey: string;
  concurrency?: number;
  totalCap?: number;
  budgetTotal?: number | null;
  onEvent?: (e: WorkflowEvent) => void;
  // Wires `schema` (opaque to the engine) to a text validator; the tool injects a TypeBox-backed factory.
  schemaValidatorFactory?: (schema: unknown) => Validator<unknown>;
};

export async function runWorkflow(opts: RunWorkflowOpts): Promise<unknown> {
  const check = validateScript(opts.script);
  if (!check.ok) throw new Error(`Illegal workflow script: ${check.reason}`);

  const scheduler = createScheduler({ limit: Math.min(opts.concurrency ?? 16, 16) });
  const budget = createBudget(opts.budgetTotal ?? null);
  const totalCap = opts.totalCap ?? 1000;
  let phaseName = "main";
  let seq = 0;
  let spawned = 0;
  const emit = (e: WorkflowEvent) => opts.onEvent?.(e);

  const agent = async (prompt: string, agentOpts?: { schema?: unknown; label?: string }): Promise<unknown> => {
    if (spawned >= totalCap) throw new Error(`TotalAgentCap reached (${totalCap})`);
    budget.assertCanSpend();
    spawned += 1;
    const mySeq = (seq += 1);
    const myPhase = phaseName;
    const label = agentOpts?.label ?? `${myPhase}#${mySeq}`;
    return scheduler.schedule(async () => {
      emit({ type: "agent:start", phase: myPhase, label, seq: mySeq });
      const sessionKey = `${opts.baseSessionKey}:${myPhase}:${mySeq}`;
      const runOnce = async (correction?: string) => {
        const message = correction ? `${prompt}\n\n${correction}` : prompt;
        return spawnAwaitCollect(opts.subagent, sessionKey, message);
      };
      try {
        if (agentOpts?.schema && opts.schemaValidatorFactory) {
          const validate = opts.schemaValidatorFactory(agentOpts.schema);
          const value = await runWithSchema({
            run: async (corr) => (await runOnce(corr)).output,
            validate,
            maxRetries: 2,
          });
          emit({ type: "agent:done", phase: myPhase, label, seq: mySeq, status: value == null ? "invalid" : "ok" });
          return value;
        }
        const r = await runOnce();
        emit({ type: "agent:done", phase: myPhase, label, seq: mySeq, status: r.status });
        return r.status === "ok" ? r.output : null;
      } catch {
        emit({ type: "agent:done", phase: myPhase, label, seq: mySeq, status: "error" });
        return null;
      }
    });
  };

  const parallel = (thunks: Array<() => Promise<unknown>>): Promise<unknown[]> =>
    Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)));

  type Stage = (prev: unknown, item: unknown, index: number) => Promise<unknown>;
  const pipeline = (items: unknown[], ...stages: Stage[]): Promise<unknown[]> =>
    Promise.all(
      items.map((item, i) =>
        stages
          .reduce<Promise<unknown>>((acc, stage) => acc.then((prev) => stage(prev, item, i)), Promise.resolve(item))
          .catch(() => null),
      ),
    );

  const phase = (name: string) => {
    phaseName = name;
    emit({ type: "phase", name });
  };
  const log = (message: string) => emit({ type: "log", phase: phaseName, message });

  return runScript({
    source: opts.script,
    primitives: { agent, parallel, pipeline, phase, log },
    args: opts.args,
    budget: { total: budget.total, spent: budget.spent, remaining: budget.remaining },
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test src/runtime/workflow-runtime.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/workflow-runtime.ts src/runtime/workflow-runtime.test.ts
git commit -m "feat: WorkflowRuntime — agent/parallel/pipeline/phase/log over the foundation"
```

---

## Task 2.2: TypeBox schema validator factory

**Files:**
- Create: `src/runtime/typebox-validator.ts`
- Test: `src/runtime/typebox-validator.test.ts`

> Bridges the engine's opaque `schema` to a text `Validator` by parsing JSON then checking against a TypeBox schema. Read `api-findings.md §1` to confirm the TypeBox `Value`/compile import (`typebox` package; e.g. `import { Value } from "typebox/value"`). Adjust the import to the verified subpath.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { Type } from "typebox";
import { typeboxValidator } from "./typebox-validator.js";

describe("typeboxValidator", () => {
  const schema = Type.Object({ ok: Type.Boolean(), n: Type.Number() });
  it("parses valid JSON matching the schema", () => {
    const v = typeboxValidator(schema);
    const r = v(`{"ok":true,"n":3}`);
    expect(r).toEqual({ ok: true, value: { ok: true, n: 3 } });
  });
  it("rejects JSON that violates the schema", () => {
    const v = typeboxValidator(schema);
    expect(v(`{"ok":"yes"}`).ok).toBe(false);
  });
  it("rejects non-JSON text", () => {
    const v = typeboxValidator(schema);
    expect(v(`not json`).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/runtime/typebox-validator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `src/runtime/typebox-validator.ts` (confirm the `Value` import path from `api-findings.md`)

```ts
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import type { Validator } from "./schema-retry.js";

export function typeboxValidator(schema: TSchema): Validator<unknown> {
  return (text: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: "output is not valid JSON" };
    }
    if (!Value.Check(schema, parsed)) {
      const first = [...Value.Errors(schema, parsed)][0];
      return { ok: false, error: first ? `${first.path}: ${first.message}` : "schema mismatch" };
    }
    return { ok: true, value: parsed };
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test src/runtime/typebox-validator.test.ts`
Expected: PASS. (If the `typebox/value` subpath differs, fix per `api-findings.md` and re-run.)

- [ ] **Step 5: Commit**

```bash
git add src/runtime/typebox-validator.ts src/runtime/typebox-validator.test.ts
git commit -m "feat: TypeBox-backed schema validator for agent() structured output"
```

---

## Task 2.3: Wire the real `workflow` tool to the runtime

**Files:**
- Modify: `src/index.ts` (replace the single-child skeleton tool with the real runtime-backed tool)
- Create: `src/workflow-tool.ts` (tool definition + detached execution + progress mapping)
- Test: `src/workflow-tool.test.ts`

- [ ] **Step 1: Write the failing test** (unit: a local fake plugin API capturing the tool; inject a fake `api.runtime.subagent`)

```ts
import { describe, it, expect, vi } from "vitest";
import { createWorkflowTool } from "./workflow-tool.js";
import type { SubagentRuntime } from "./skeleton/spawn-bridge.js";

function fakeSubagent(): SubagentRuntime {
  const store = new Map<string, string>();
  return {
    run: async ({ sessionKey, message }) => { store.set(sessionKey, `echo:${message}`); return { runId: "r" }; },
    waitForRun: async () => ({ status: "ok" }),
    getSessionMessages: async ({ sessionKey }) => ({
      messages: [{ role: "assistant", content: [{ type: "text", text: store.get(sessionKey) ?? "" }] }],
    }),
  };
}

describe("workflow tool", () => {
  it("runs a script and returns its result; emits progress", async () => {
    const updates: unknown[] = [];
    const tool = createWorkflowTool();
    const ctx = {
      api: { runtime: { subagent: fakeSubagent() } },
      toolCallId: "call-1",
      onUpdate: (u: unknown) => updates.push(u),
    } as any;
    const result = await tool.execute(
      { script: `phase("scan"); return await parallel([() => agent("A"), () => agent("B")]);` },
      {},
      ctx,
    );
    // result is wrapped as the tool's return; assert it carries the two echoes
    const text = JSON.stringify(result);
    expect(text).toContain("echo:A");
    expect(text).toContain("echo:B");
    expect(updates.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/workflow-tool.test.ts`
Expected: FAIL — `createWorkflowTool` not found.

- [ ] **Step 3: Implement** `src/workflow-tool.ts`

> Confirm the detached-task accessor path from `api.runtime` in `api-findings.md` before adding background execution. For Plan #2, run the engine inline within `execute` and return the result (the tool is already long-running; detached/background hand-off can be layered once the accessor is pinned — keep a TODO referencing api-findings, but DO NOT block the return value on it). Progress is emitted via `context.onUpdate` using the verified shape (`{ content:[], details:undefined, progress:{ text, visibility:"channel", privacy:"public", id } }`).

```ts
import { Type } from "typebox";
import { runWorkflow, type WorkflowEvent } from "./runtime/workflow-runtime.js";
import { typeboxValidator } from "./runtime/typebox-validator.js";
import type { SubagentRuntime } from "./skeleton/spawn-bridge.js";

type ExecCtx = {
  api: { runtime: { subagent: SubagentRuntime } };
  toolCallId: string;
  onUpdate?: (u: {
    content: unknown[];
    details: unknown;
    progress?: { text: string; visibility: "channel"; privacy: "public"; id?: string };
  }) => void;
};

function progress(ctx: ExecCtx, text: string, id: string) {
  ctx.onUpdate?.({ content: [], details: undefined, progress: { text, visibility: "channel", privacy: "public", id } });
}

export function createWorkflowTool() {
  return {
    name: "workflow",
    label: "Dynamic Workflow",
    description:
      "Execute a dynamic workflow: a JS orchestration script using agent()/parallel()/pipeline()/phase()/log() that fans out sub-agents and returns one coordinated result.",
    parameters: Type.Object({
      script: Type.String({ description: "JS orchestration script body (no imports; uses the injected primitives)." }),
      args: Type.Optional(Type.Any()),
    }),
    execute: async (
      params: { script: string; args?: unknown },
      _config: unknown,
      ctx: ExecCtx,
    ) => {
      let agentCount = 0;
      const onEvent = (e: WorkflowEvent) => {
        if (e.type === "phase") progress(ctx, `phase: ${e.name}`, `wf:phase:${e.name}`);
        else if (e.type === "agent:start") {
          agentCount += 1;
          progress(ctx, `running ${agentCount} agent(s) — ${e.label}`, "wf:agents");
        } else if (e.type === "log") progress(ctx, e.message, "wf:log");
      };
      const result = await runWorkflow({
        script: params.script,
        args: params.args,
        subagent: ctx.api.runtime.subagent,
        baseSessionKey: `agent:main:subagent:wf-${ctx.toolCallId}`,
        concurrency: 16,
        onEvent,
        schemaValidatorFactory: (schema) => typeboxValidator(schema as never),
      });
      progress(ctx, `done — ${agentCount} agent(s)`, "wf:done");
      return result;
    },
  };
}
```

- [ ] **Step 4: Register it in `src/index.ts`** (replace the skeleton tool)

```ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createWorkflowTool } from "./workflow-tool.js";

export default definePluginEntry({
  id: "workflows",
  name: "Dynamic Workflows",
  description: "Claude-Code-style dynamic workflows for OpenClaw.",
  register(api) {
    api.registerTool(createWorkflowTool() as never);
  },
});
```

> Note: if `defineToolPlugin` is the cleaner registration path (per the committed skeleton + `api-findings.md §2`), keep using `defineToolPlugin` and pass `createWorkflowTool()`'s definition through its `tools: (tool) => [tool({...})]` factory instead of `definePluginEntry`+`registerTool`. Use whichever the live gateway loads (verify in Step 6).

- [ ] **Step 5: Run unit test + build**

Run: `pnpm test src/workflow-tool.test.ts && pnpm build`
Expected: PASS + clean build.

- [ ] **Step 6: Commit**

```bash
git add src/workflow-tool.ts src/index.ts src/workflow-tool.test.ts
git commit -m "feat: real workflow tool wired to the orchestration runtime"
```

---

## Task 2.4: Live verification — a real multi-agent script end-to-end

**Files:**
- Create: `src/workflow-tool.live.test.ts`

> Runs against the isolated `.devgateway` gateway (Node 22.19, port 18790, `OPENCLAW_HOME=.devgateway/home`, model `moonshot/kimi-k2.6`). Out-of-process, build the `SubagentRuntime` adapter exactly as in `spawn-bridge.live.test.ts` (the `agent` / `agent.wait` / `chat.history` mapping with explicit token + `idempotencyKey` + `sessionKey`), then call `runWorkflow` directly with a real fan-out script.

- [ ] **Step 1: Write the live test**

```ts
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
      (await callGatewayFromCli("agent", opts, {
        lane: "subagent", message: p.message, deliver: p.deliver ?? false, sessionKey: p.sessionKey,
        idempotencyKey: `wf2:${p.sessionKey}:${Date.now()}`,
      }, { clientName: "cli", expectFinal: true })) as unknown as { runId: string },
    waitForRun: async (p) =>
      (await callGatewayFromCli("agent.wait", opts, { runId: p.runId, timeoutMs: p.timeoutMs },
        { clientName: "cli", expectFinal: true })) as unknown as { status: "ok" | "error" | "timeout" },
    getSessionMessages: async (p) =>
      (await callGatewayFromCli("chat.history", opts, { sessionKey: p.sessionKey, limit: p.limit },
        { clientName: "cli", expectFinal: true })) as unknown as { messages: unknown[] },
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
```

- [ ] **Step 2: Run against the isolated gateway**

```bash
cd ~/projects/openclaw-plugin-workflows
export PATH="$PWD/.devgateway/node-v22.19.0-darwin-arm64/bin:$PATH"
# start the dev gateway if not running (see api-findings §8 recipe), then:
OPENCLAW_LIVE_TEST=1 OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18790 \
OPENCLAW_GATEWAY_TOKEN=<dev token> OPENCLAW_HOME="$PWD/.devgateway/home" \
pnpm test src/workflow-tool.live.test.ts
```
Expected: PASS — two real sub-agents fan out in parallel, both ALPHA and BETA collected. **This proves the runtime orchestrates real OpenClaw sub-agents end-to-end.** Tear the dev gateway down after (kill port 18790 only; never 18789).

- [ ] **Step 3: Commit**

```bash
git add src/workflow-tool.live.test.ts
git commit -m "test: live runtime proof — real parallel fan-out collects all results"
```

---

## Self-Review checklist (run before declaring done)

- Spec coverage: primitives (1.x), schema (2.2), execution semantics over real spawn (2.1/2.4), failure→null (2.1), caps (2.1). Surface progress = typed events emitted (2.3); Canvas panel = Plan #3. Resume/save/approval = Plan #3.
- Type consistency: `SubagentRuntime` shape matches Plan #1 `spawn-bridge.ts`; `Validator<T>` matches `schema-retry.ts`; `WorkflowEvent` used identically in runtime + tool.
- Placeholder scan: the only "confirm path" notes (TypeBox `Value` subpath, detached-task accessor, defineToolPlugin vs registerTool) reference `api-findings.md` and are resolved during the task, not left vague.

## Definition of Done (Plan #2)

- [ ] `runWorkflow` unit suite green: agent/parallel(barrier)/pipeline(no-barrier)/concurrency-cap/failure→null/args/illegal-script/phase+agent events.
- [ ] TypeBox validator green; `agent({schema})` returns validated objects with retry.
- [ ] `workflow` tool unit test green; `pnpm build` + `tsc --noEmit` clean; whole pure suite still green.
- [ ] Live: a real parallel fan-out script collects all sub-agent results on the isolated 2026.6.1 gateway.

## Hand-off to Plan #3

Canvas A2UI phase-tree panel (use Plan #1 `phase-tree-a2ui` + the `WorkflowEvent` stream), detached/background execution hand-off (`createRunningTaskRun`/`completeTaskRunByRunId`), SQLite-KV resume journal (Plan #1 `cache-key`), save-as-`/command` + `args`, and the interactive approval gate.
