# openclaw-plugin-workflows — Plan #3: Surface, Detached, Resume, Save, Approval

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Round out the `workflow` capability with: a live Canvas phase-tree panel, an approval gate, detached background execution (main session stays responsive), a resume journal, and save/run-saved workflows.

**Architecture:** Reuse the Plan #2 `WorkflowEvent` stream. A `CanvasSurface` renders the phase tree (Plan #1 `phase-tree-a2ui`) and pushes it via `api.runtime.nodes.invoke("canvas.a2ui.pushJSONL")`. Approval rides `api.on("before_tool_call")` → `requireApproval`. Because external plugins cannot use `createRunningTaskRun`/`openKeyedStore` (trust-gated/core-internal — see `api-findings.md §9`), background execution + resume + saved-defs are built on the **sanctioned plugin surfaces**: `api.runtime.tasks.managedFlows` (durable flow `stateJson`) + `api.session.workflow.scheduleSessionTurn` for the wakeup.

**Tech Stack:** TS ESM, Vitest, `openclaw/plugin-sdk/*`, TypeBox. Verified mechanism map: `api-findings.md §9`.

**Scope:** Plan #3 of 3. Builds on Plan #1 (foundation) + Plan #2 (runtime, committed). Delivers the full surface + lifecycle. Per `§9`, several pieces are **unit-testable but only manually/partially live-verifiable in the isolated dev gateway** (Canvas needs a paired node; approval needs a human; detached/resume need the session-turn machinery) — each task states its honest verification level.

**Conventions:** `pnpm test <path>` (never raw vitest); commit after each green task; in a Workflow run agents don't commit (orchestrator commits after review). Live where noted runs against the isolated `.devgateway` gateway (port 18790); never touch 18789 / `~/.openclaw` / `~/.stepfun`.

---

## Task 3.1: Canvas phase-tree surface (push A2UI from the event stream)

**Files:** Create `src/surface/canvas-surface.ts` + `src/surface/canvas-surface.test.ts`

Verified API (`api-findings.md §9.3`): `api.runtime.nodes.invoke({ nodeId, command: "canvas.a2ui.pushJSONL", params: { jsonl } })`. We inject a narrow `NodesInvoke` so the surface is unit-testable without a node; the plugin wires the real `api.runtime.nodes` + resolves the paired node + `canvas.present` at runtime.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { createCanvasSurface } from "./canvas-surface.js";
import type { WorkflowEvent } from "../runtime/workflow-runtime.js";

describe("createCanvasSurface", () => {
  it("renders the phase tree from events and pushes A2UI JSONL via nodes.invoke", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const surface = createCanvasSurface({ nodesInvoke: invoke, nodeId: "node-1" });
    const events: WorkflowEvent[] = [
      { type: "phase", name: "scan" },
      { type: "agent:start", phase: "scan", label: "file1", seq: 1 },
      { type: "agent:done", phase: "scan", label: "file1", seq: 1, status: "ok" },
    ];
    for (const e of events) surface.onEvent(e);
    await surface.flush();
    expect(invoke).toHaveBeenCalled();
    const call = invoke.mock.calls.at(-1)![0];
    expect(call.command).toBe("canvas.a2ui.pushJSONL");
    expect(call.nodeId).toBe("node-1");
    expect(String(call.params.jsonl)).toContain("scan");
    expect(String(call.params.jsonl)).toContain("file1");
  });

  it("is a no-op when no nodeId is available (headless dev gateway)", async () => {
    const invoke = vi.fn();
    const surface = createCanvasSurface({ nodesInvoke: invoke, nodeId: undefined });
    surface.onEvent({ type: "phase", name: "x" });
    await surface.flush();
    expect(invoke).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run → FAIL** (`pnpm test src/surface/canvas-surface.test.ts`)

- [ ] **Step 3: Implement** `src/surface/canvas-surface.ts`

```ts
import { buildPhaseTreeA2UI, type PhaseView } from "./phase-tree-a2ui.js";
import type { WorkflowEvent } from "../runtime/workflow-runtime.js";

export type NodesInvoke = (params: {
  nodeId: string;
  command: string;
  params: { jsonl: string };
}) => Promise<unknown>;

export function createCanvasSurface(opts: { nodesInvoke: NodesInvoke; nodeId?: string }) {
  const phases: PhaseView[] = [];
  const byName = new Map<string, PhaseView>();
  const phaseOf = (name: string) => {
    let p = byName.get(name);
    if (!p) { p = { name, agents: [] }; byName.set(name, p); phases.push(p); }
    return p;
  };

  const onEvent = (e: WorkflowEvent) => {
    if (e.type === "phase") phaseOf(e.name);
    else if (e.type === "agent:start") phaseOf(e.phase).agents.push({ label: e.label, status: "running" });
    else if (e.type === "agent:done") {
      const a = phaseOf(e.phase).agents.find((x) => x.label === e.label);
      if (a) a.status = e.status;
    }
  };

  const flush = async () => {
    if (!opts.nodeId) return; // headless: no paired canvas node, nothing to render
    const jsonl = buildPhaseTreeA2UI(phases);
    await opts.nodesInvoke({ nodeId: opts.nodeId, command: "canvas.a2ui.pushJSONL", params: { jsonl } });
  };

  return { onEvent, flush };
}
```

- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `feat: canvas phase-tree surface (A2UI push from event stream)`.

> Verification level: **unit** (deterministic). Live Canvas rendering needs a paired node + canvas plugin (`§9.3`) — not present in the isolated dev gateway; mark as **manual demo on a real paired device**, do not claim auto-verified.

---

## Task 3.2: Approval gate (before_tool_call → requireApproval)

**Files:** Create `src/approval.ts` + `src/approval.test.ts`; wire in `src/index.ts`.

Verified API (`§9.5`): a plugin calls `api.on("before_tool_call", handler)`; returning `{ requireApproval: { title, description, severity?, timeoutMs?, timeoutBehavior?, allowedDecisions? } }` blocks the call until the user resolves. Key on `toolName === "workflow"`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { workflowApprovalHandler } from "./approval.js";

describe("workflowApprovalHandler", () => {
  it("requires approval for the workflow tool, surfacing the planned script", async () => {
    const r = await workflowApprovalHandler({
      toolName: "workflow",
      params: { script: `phase("scan"); await agent("x");` },
    } as never);
    expect(r?.requireApproval?.title).toMatch(/workflow/i);
    expect(r?.requireApproval?.description).toContain("scan");
  });

  it("ignores non-workflow tools", async () => {
    const r = await workflowApprovalHandler({ toolName: "bash", params: {} } as never);
    expect(r).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `src/approval.ts` (confirm the exact `before_tool_call` event arg + return type names against `§9.5` / `hook-types.ts:556`; adjust types to the real ones)

```ts
type BeforeToolCall = { toolName: string; params?: Record<string, unknown> };
type ApprovalResult = {
  requireApproval: { title: string; description: string; severity?: "info" | "warn" | "danger" };
} | undefined;

export async function workflowApprovalHandler(call: BeforeToolCall): Promise<ApprovalResult> {
  if (call.toolName !== "workflow") return undefined;
  const script = typeof call.params?.script === "string" ? call.params.script : "";
  const preview = script.length > 600 ? `${script.slice(0, 600)}…` : script;
  return {
    requireApproval: {
      title: "Run dynamic workflow?",
      description: `This will fan out sub-agents per the script:\n\n${preview}`,
      severity: "warn",
    },
  };
}
```

- [ ] **Step 4: Wire in `src/index.ts`** inside `register(api)`: `api.on("before_tool_call", workflowApprovalHandler as never);` (keep the `defineToolPlugin` tool registration). Confirm `api.on` is available on the entry's register api (`§9.5`); if the hook registers via a different surface, use that.

- [ ] **Step 5: Run → PASS; `pnpm build`.** **Step 6: Commit** `feat: approval gate for the workflow tool`.

> Verification level: **unit** for the handler logic. Live (the gateway actually blocking on user approval) needs a human approver — **manual**.

---

## Task 3.3: Pin the managedFlows + scheduleSessionTurn signatures (discovery)

**Files:** append to `docs/superpowers/plans/api-findings.md` (§10).

External plugins can't use `createRunningTaskRun`/`openKeyedStore` (`§9.1`, `§9.2`). Background + resume use `api.runtime.tasks.managedFlows` + `api.session.workflow.scheduleSessionTurn`. Their EXACT signatures must be read before coding 3.4–3.6.

- [ ] **Step 1: Read & record exact signatures** from the source clone `~/projects/openclaw` (re-confirm in 2026.6.1 d.ts):
  - `api.runtime.tasks.managedFlows` shape — from `src/plugins/runtime/runtime-taskflow.types.ts:71` and `runtime-tasks.ts`. Record: how to create a flow, read/write its `stateJson`, list/get by id, and the flow id/owner model.
  - `api.session.workflow.scheduleSessionTurn` — from `src/plugins/runtime/types.ts:2549` + params at `host-hooks.ts:276`. Record the exact params (sessionKey, when, payload?) and what waking a turn delivers.
  - The "background started" tool return convention — `details:{async:true,status:"started",taskId,runId}` (`media-generate-background-shared.ts:320`).
- [ ] **Step 2: Write the signatures into `api-findings.md §10`**, then **commit** `docs: pin managedFlows + scheduleSessionTurn signatures`.

> This task gates 3.4–3.6. Do it first; those tasks reference its recorded signatures.

---

## Task 3.4: Detached background execution

**Files:** Modify `src/workflow-tool.ts`; Create `src/runtime/detached.ts` + `src/runtime/detached.test.ts`.

Goal: `workflow` tool returns immediately with a "started" handle; `runWorkflow` runs under a managed flow; progress + final result are delivered via `scheduleSessionTurn`. Use the signatures from 3.3.

- [ ] **Step 1: Write the failing test** — inject fake `managedFlows` + `scheduleSessionTurn` (no gateway):

```ts
import { describe, it, expect, vi } from "vitest";
import { runDetached } from "./detached.js";

describe("runDetached", () => {
  it("creates a flow, runs the engine in background, persists result, schedules a wakeup", async () => {
    const flow = { id: "flow-1", setState: vi.fn().mockResolvedValue(undefined) };
    const managedFlows = { create: vi.fn().mockResolvedValue(flow) };
    const scheduleSessionTurn = vi.fn().mockResolvedValue(undefined);
    const started = await runDetached({
      managedFlows, scheduleSessionTurn, sessionKey: "agent:main:x",
      run: async () => "RESULT",
    } as never);
    expect(started.status).toBe("started");
    expect(started.flowId).toBe("flow-1");
    // let the background microtask settle
    await new Promise((r) => setTimeout(r, 5));
    expect(flow.setState).toHaveBeenCalledWith(expect.objectContaining({ status: "done", result: "RESULT" }));
    expect(scheduleSessionTurn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `src/runtime/detached.ts` (shape adjusted to 3.3's real `managedFlows.create` / `setState` / `scheduleSessionTurn` signatures)

```ts
export type DetachedDeps = {
  managedFlows: { create: (init: { kind: string; stateJson: unknown }) => Promise<{ id: string; setState: (s: unknown) => Promise<void> }> };
  scheduleSessionTurn: (p: { sessionKey: string; reason: string }) => Promise<void>;
  sessionKey: string;
  run: () => Promise<unknown>;
};

export async function runDetached(deps: DetachedDeps): Promise<{ status: "started"; flowId: string }> {
  const flow = await deps.managedFlows.create({ kind: "workflow", stateJson: { status: "running" } });
  // Fire-and-forget the engine; deliver completion via flow state + a scheduled wakeup turn.
  void (async () => {
    try {
      const result = await deps.run();
      await flow.setState({ status: "done", result });
    } catch (err) {
      await flow.setState({ status: "failed", error: err instanceof Error ? err.message : String(err) });
    }
    await deps.scheduleSessionTurn({ sessionKey: deps.sessionKey, reason: `workflow ${flow.id} finished` });
  })();
  return { status: "started", flowId: flow.id };
}
```

- [ ] **Step 4: Wire `workflow` tool** to call `runDetached` when `api.session?.workflow?.scheduleSessionTurn` + `api.runtime.tasks.managedFlows` are present; else fall back to inline await (Plan #2 behavior). Return `{ details: { async: true, status: "started", flowId } }` per the convention. Keep emitting `onUpdate` progress while running.

- [ ] **Step 5: Run → PASS; `pnpm build`.** **Step 6: Commit** `feat: detached background execution via managedFlows + scheduleSessionTurn`.

> Verification level: **unit** (fakes). Full live (a real backgrounded turn waking the session) needs the session-turn machinery — **manual/integration on a real interactive session**, not the isolated headless gateway.

---

## Task 3.5: Resume journal (managedFlow stateJson, keyed by cache-key)

**Files:** Create `src/runtime/resume-journal.ts` + test; integrate into `runWorkflow` (optional `journal` dep).

`openKeyedStore` is trust-gated (`§9.2`), so the journal lives in the flow's `stateJson`. Keyed by Plan #1 `agentCacheKey`. On resume, a completed `agent()` returns its cached output; only missing agents re-spawn.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { createResumeJournal } from "./resume-journal.js";

describe("createResumeJournal", () => {
  it("returns cached results for seen keys; records new ones", async () => {
    const store: Record<string, unknown> = {};
    const j = createResumeJournal({
      read: async () => store,
      write: async (s) => { Object.assign(store, s); },
      scriptHash: "h", args: { a: 1 },
    });
    const k = { callSite: "scan#1", prompt: "audit x" };
    expect(await j.get(k)).toBeUndefined();
    await j.put(k, "RESULT");
    expect(await j.get(k)).toBe("RESULT");
    // a different prompt is a miss
    expect(await j.get({ callSite: "scan#1", prompt: "audit y" })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `src/runtime/resume-journal.ts` (uses `agentCacheKey` from Plan #1)

```ts
import { agentCacheKey } from "./cache-key.js";

export function createResumeJournal(opts: {
  read: () => Promise<Record<string, unknown>>;
  write: (entries: Record<string, unknown>) => Promise<void>;
  scriptHash: string;
  args: unknown;
}) {
  const key = (k: { callSite: string; prompt: string }) =>
    agentCacheKey({ scriptHash: opts.scriptHash, args: opts.args, callSite: k.callSite, prompt: k.prompt });
  return {
    get: async (k: { callSite: string; prompt: string }) => (await opts.read())[key(k)],
    put: async (k: { callSite: string; prompt: string }, value: unknown) => {
      await opts.write({ [key(k)]: value });
    },
  };
}
```

- [ ] **Step 4: Integrate into `runWorkflow`** — add an optional `journal` dep; in `agent()`, check `journal.get({callSite, prompt})` before spawning (callSite = `${myPhase}#${mySeq}`), and `journal.put(...)` on success. Add a unit test in `workflow-runtime.test.ts`: a re-run with a pre-populated journal spawns 0 sub-agents (assert via a counting fake subagent).

- [ ] **Step 5: Run → PASS; `pnpm build`.** **Step 6: Commit** `feat: resume journal (managedFlow stateJson, cache-key keyed)`.

> Verification level: **unit** (deterministic — the cache semantics are pure). Cross-turn live resume is covered structurally by the unit test; full live needs the detached/session-turn path.

---

## Task 3.6: Save / run-saved workflows

**Files:** Modify `src/workflow-tool.ts` (extend params); Create `src/runtime/saved-store.test.ts`.

No runtime command registration (`§9.4`); a saved workflow is a stored def replayed via a fixed tool param. Extend the `workflow` tool params to a discriminated action:
`{ action?: "run" | "save" | "run-saved"; script?; args?; id?; name? }` (default `"run"`).

- [ ] **Step 1: Write the failing test** (logic only; storage injected)

```ts
import { describe, it, expect } from "vitest";
import { resolveWorkflowAction } from "./saved-store.js";

describe("resolveWorkflowAction", () => {
  const store = new Map<string, { name: string; script: string }>();
  const deps = {
    save: async (id: string, def: { name: string; script: string }) => { store.set(id, def); },
    load: async (id: string) => store.get(id),
  };
  it("save stores the def; run-saved loads the script + applies args", async () => {
    const saved = await resolveWorkflowAction({ action: "save", id: "audit", name: "Audit", script: "await agent('x')" }, deps);
    expect(saved.kind).toBe("saved");
    const run = await resolveWorkflowAction({ action: "run-saved", id: "audit", args: { n: 1 } }, deps);
    expect(run.kind).toBe("run");
    expect(run.script).toBe("await agent('x')");
    expect(run.args).toEqual({ n: 1 });
  });
  it("run-saved on a missing id errors", async () => {
    await expect(resolveWorkflowAction({ action: "run-saved", id: "nope" }, deps)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `src/runtime/saved-store.ts`

```ts
export type SavedStoreDeps = {
  save: (id: string, def: { name: string; script: string }) => Promise<void>;
  load: (id: string) => Promise<{ name: string; script: string } | undefined>;
};
export type WorkflowActionParams = {
  action?: "run" | "save" | "run-saved";
  script?: string; args?: unknown; id?: string; name?: string;
};
export type ResolvedAction =
  | { kind: "run"; script: string; args: unknown }
  | { kind: "saved"; id: string };

export async function resolveWorkflowAction(p: WorkflowActionParams, deps: SavedStoreDeps): Promise<ResolvedAction> {
  const action = p.action ?? "run";
  if (action === "save") {
    if (!p.id || !p.script) throw new Error("save requires id + script");
    await deps.save(p.id, { name: p.name ?? p.id, script: p.script });
    return { kind: "saved", id: p.id };
  }
  if (action === "run-saved") {
    if (!p.id) throw new Error("run-saved requires id");
    const def = await deps.load(p.id);
    if (!def) throw new Error(`saved workflow not found: ${p.id}`);
    return { kind: "run", script: def.script, args: p.args };
  }
  if (!p.script) throw new Error("run requires script");
  return { kind: "run", script: p.script, args: p.args };
}
```

- [ ] **Step 4: Wire into `workflow-tool.ts`** — parse `action`, back `save`/`load` with the managedFlow stateJson store (a `savedWorkflows` flow), then run resolved scripts through the engine.

- [ ] **Step 5: Run → PASS; `pnpm build`.** **Step 6: Commit** `feat: save / run-saved workflows`.

> Verification level: **unit** for the action logic. Live persistence rides the managedFlow store (3.3/3.4).

---

## Task 3.7: Live re-verification (what the isolated gateway CAN prove)

**Files:** reuse `src/workflow-tool.live.test.ts` (extend with a `run-saved` case if storage is wired).

- [ ] **Step 1:** With the dev gateway up (`api-findings.md §8` recipe, kimi-k2.6), re-run `OPENCLAW_LIVE_TEST=1 … pnpm test src/workflow-tool.live.test.ts` — the parallel fan-out must still pass (regression guard after the tool changes). Tear the gateway down (kill 18790 only).
- [ ] **Step 2: Commit** any test updates.

> The Canvas panel, the approval block, and a real backgrounded session-turn are **not** auto-verifiable on the isolated headless gateway (no paired node / no human / no interactive session). State this honestly; they are unit-tested + flagged for manual demo on a real device/session.

---

## Self-Review checklist

- Spec coverage: surface/progress Canvas (3.1) + approval (3.2); detached background (3.4); resume (3.5); save (3.6). All spec §7/§8 items now have a task.
- Type consistency: `WorkflowEvent` reused from Plan #2; `agentCacheKey` from Plan #1; `PhaseView` from Plan #1 `phase-tree-a2ui`.
- Placeholder scan: the managedFlows/scheduleSessionTurn signatures are pinned in Task 3.3 BEFORE 3.4–3.6 use them — not guessed.

## Definition of Done (Plan #3)

- [ ] Canvas surface unit test green (event stream → A2UI JSONL → nodes.invoke).
- [ ] Approval handler unit test green; wired via `api.on("before_tool_call")`.
- [ ] managedFlows + scheduleSessionTurn signatures pinned in `api-findings.md §10`.
- [ ] Detached execution unit test green; tool returns "started"; inline fallback preserved.
- [ ] Resume journal unit test green; re-run with populated journal spawns 0 sub-agents.
- [ ] Save / run-saved unit test green.
- [ ] `pnpm test` (whole suite) + `pnpm build` clean; live parallel fan-out still passes (regression).
- [ ] Honest verification ledger: which items are unit-only vs manually-demoable vs live-proven.
