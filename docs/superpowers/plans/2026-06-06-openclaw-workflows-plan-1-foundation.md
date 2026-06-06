# openclaw-plugin-workflows — Plan #1: Spike + Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `openclaw-plugin-workflows` package, de-risk the OpenClaw plugin-SDK execution spine with a walking skeleton proven on a real Gateway, and build the OpenClaw-independent pure-logic foundation (vm sandbox, concurrency scheduler, budget, schema-retry, cache-key, static-validator, A2UI phase-tree builder) with full unit coverage.

**Architecture:** A standalone OpenClaw plugin registers a `workflow` tool whose `execute` runs an LLM-authored JS orchestration script inside a `node:vm` sandbox. Script primitives fan out work to real OpenClaw sub-sessions (spawn → `agent.wait` → `chat.history`) through a host bridge built on `GatewayClient`. This plan delivers the spike + the pure modules; the SDK-wired execution/surface/resume/acceptance layers are **Plan #2**, authored after Phase 0 returns exact signatures.

**Tech Stack:** TypeScript ESM (strict), Vitest, `node:vm`, TypeBox (via OpenClaw SDK), `openclaw/plugin-sdk/*`, pnpm. Node 22.19+/24.

**Scope:** This is **Plan #1 of 2**. It produces working, independently-testable software: a loadable plugin with a proven spawn→await→collect skeleton, plus fully-tested pure modules that Plan #2 wires together. Spec: `docs/superpowers/specs/2026-06-06-openclaw-workflows-design.md`.

**Conventions for every task:** run tests with `pnpm test <path>` (never raw `vitest`). Commit after each green task. Pure-logic tests (Phase 1) need no OpenClaw. Live tests (Phase 0 T0.7) are gated behind `OPENCLAW_LIVE_TEST=1` and need a real Gateway + model key.

---

## Phase 0 — Spike: scaffold, discover SDK surface, prove the spine

### Task 0.1: Bump Node to 22.19+

**Files:** none (environment).

- [ ] **Step 1: Check current Node**

Run: `node -v`
Expected: prints a version. If `< v22.19.0`, continue; else skip to 0.2.

- [ ] **Step 2: Install + use Node 22.19+ (or 24)**

Run (fnm or nvm, whichever is installed):
```bash
fnm install 22.19.0 && fnm use 22.19.0   # or: nvm install 22.19.0 && nvm use 22.19.0
node -v
```
Expected: `v22.19.0` (or a 24.x). Record an `.nvmrc`/`.node-version` file:
```bash
echo "22.19.0" > ~/projects/openclaw-plugin-workflows/.node-version
```

- [ ] **Step 3: Commit**

```bash
cd ~/projects/openclaw-plugin-workflows
git add .node-version && git commit -m "chore: pin Node 22.19"
```

### Task 0.2: Pin SDK import specifiers + manifest schema + link method

**Files:**
- Create: `docs/superpowers/plans/api-findings.md` (the spike's living output)

- [ ] **Step 1: Read the authoring contracts in the OpenClaw clone**

Read these in `~/projects/openclaw`:
- `docs/plugins/building-plugins.md`, `docs/plugins/sdk-entrypoints.md`, `docs/plugins/sdk-overview.md`, `docs/plugins/manifest.md`
- `scripts/lib/plugin-sdk-entrypoints.json` (authoritative subpath list)
- `src/plugin-sdk/plugin-entry.ts` (for `definePluginEntry` / `OpenClawPluginApi` / `OpenClawPluginToolContext`)

- [ ] **Step 2: Record exact specifiers into `api-findings.md`**

Capture the real values (do not guess — copy from the files):
- import specifier for `defineToolPlugin` / `definePluginEntry`
- how to obtain TypeBox `Type` (SDK re-export vs `@sinclair/typebox` dependency)
- import specifier for `GatewayClient` (confirmed: `openclaw/plugin-sdk/gateway-runtime`) and the type of `api.runtime`
- the `onUpdate` (`AgentToolUpdateCallback`) shape and the `emitToolProgress` helper location
- the `openclaw.plugin.json` manifest required fields + the package `openclaw` block
- the local-link command (`openclaw plugins install --link ./` and `openclaw gateway restart`)

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/api-findings.md
git commit -m "docs: pin OpenClaw plugin-SDK specifiers for the workflows plugin"
```

### Task 0.3: Scaffold the package

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `openclaw.plugin.json`, `src/index.ts`

- [ ] **Step 1: Write `package.json`** (fill SDK/TypeBox specifiers from `api-findings.md`)

```json
{
  "name": "openclaw-plugin-workflows",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./dist/index.js" },
  "main": "./dist/index.js",
  "files": ["dist", "openclaw.plugin.json"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": { "openclaw": "*" },
  "devDependencies": {
    "openclaw": "link:../openclaw",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Write `openclaw.plugin.json`** (shape from `api-findings.md`; this is a representative skeleton)

```json
{
  "id": "workflows",
  "name": "Dynamic Workflows",
  "description": "Claude-Code-style dynamic workflows: orchestrate many sub-agents from an LLM-written script.",
  "entry": "./dist/index.js",
  "contracts": { "tools": ["workflow"] }
}
```

- [ ] **Step 5: Write `src/index.ts`** (plugin entry stub — registers nothing yet)

```ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "workflows",
  name: "Dynamic Workflows",
  description: "Claude-Code-style dynamic workflows for OpenClaw.",
  register() {
    // Tools registered in Task 0.6 (skeleton) and Plan #2.
  },
});
```

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts openclaw.plugin.json src/index.ts
git commit -m "chore: scaffold openclaw-plugin-workflows package"
```

### Task 0.4: Install, build, link, and verify registration

**Files:** none (build/link).

- [ ] **Step 1: Install deps + build**

Run:
```bash
cd ~/projects/openclaw-plugin-workflows
pnpm install
pnpm build
```
Expected: `dist/index.js` exists, no TS errors.

- [ ] **Step 2: Link into OpenClaw and restart the gateway**

Run:
```bash
openclaw plugins install --link ~/projects/openclaw-plugin-workflows
openclaw gateway restart
openclaw plugins inspect workflows --runtime --json
```
Expected: JSON shows the `workflows` plugin loaded (tools list empty for now — proves the entry resolves). If it fails, fix the manifest/entry per `api-findings.md` before proceeding.

### Task 0.5: Confirm the spine RPCs are callable from a plugin tool

**Files:**
- Modify: `docs/superpowers/plans/api-findings.md`

- [ ] **Step 1: Trace the gateway RPCs**

In `~/projects/openclaw`, read `src/gateway/client.ts` (`GatewayClient`) and the server methods for `agent`, `agent.wait`, `chat.history` (`src/gateway/server-methods/*`). Confirm: the exact method names, params, return shapes, and whether a plugin-obtained `GatewayClient` carries the auth/scope to call them. Confirm the spawn path uses `agent` with `lane:"subagent"` and that `agent.wait({runId, timeoutMs})` returns a terminal status.

- [ ] **Step 2: Trace the detached-task registration from a plugin**

Read `src/tasks/detached-task-runtime.ts` + how a plugin obtains `createRunningTaskRun` / `recordTaskRunProgressByRunId` / `completeTaskRunByRunId` (via `api.runtime` or an SDK subpath). Record the exact access path.

- [ ] **Step 3: Record verdict in `api-findings.md`** (GREEN/blocked + exact call sequence) and commit.

```bash
git add docs/superpowers/plans/api-findings.md
git commit -m "docs: confirm spawn/agent.wait/chat.history spine callable from plugin"
```

### Task 0.6: Walking skeleton — spawn 1 child, await, collect, one progress event

**Files:**
- Create: `src/skeleton/spawn-bridge.ts`
- Modify: `src/index.ts` (register a temporary `workflow` tool)

> ⚠️ **CORRECTED after the spike (see `api-findings.md` + the committed `src/skeleton/spawn-bridge.ts`):** the code below was WRONG — there is no `api.runtime.gatewayClient()` and plugins do not call raw `agent`/`agent.wait`/`chat.history` RPCs in-process. The real spine is the injected **`api.runtime.subagent`**: `run({sessionKey, message, deliver:false}) → {runId}`, `waitForRun({runId, timeoutMs}) → {status}`, `getSessionMessages({sessionKey}) → {messages: unknown[]}`. The implemented `spawn-bridge.ts` uses that surface; treat the block below as historical.

- [ ] **Step 1: Write the host bridge** `src/skeleton/spawn-bridge.ts`

```ts
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

export type SpawnResult = { runId: string; childSessionKey: string };

// Spawn one isolated sub-agent and block (in code) until it finishes, then read its final text.
export async function spawnAwaitCollect(
  client: GatewayClient,
  task: string,
  timeoutMs = 120_000,
): Promise<{ status: string; output: string }> {
  const spawned = (await client.call("agent", {
    lane: "subagent",
    message: task,
    deliver: false,
  })) as SpawnResult & { status: string };

  const waited = (await client.call("agent.wait", {
    runId: spawned.runId,
    timeoutMs,
  })) as { status: string };

  const history = (await client.call("chat.history", {
    key: spawned.childSessionKey,
  })) as { messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> };

  const last = [...history.messages].reverse().find((m) => m.role === "assistant");
  const output = last?.content.map((c) => c.text ?? "").join("") ?? "";
  return { status: waited.status, output };
}
```

- [ ] **Step 2: Register a temporary `workflow` tool in `src/index.ts`** (single-child skeleton; replaced in Plan #2)

```ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "openclaw/plugin-sdk/plugin-entry"; // adjust per api-findings.md
import { spawnAwaitCollect } from "./skeleton/spawn-bridge.js";

export default definePluginEntry({
  id: "workflows",
  name: "Dynamic Workflows",
  description: "Claude-Code-style dynamic workflows for OpenClaw.",
  register(api) {
    api.registerTool({
      name: "workflow",
      description: "Run a dynamic workflow (skeleton: spawns one sub-agent).",
      parameters: Type.Object({ task: Type.String() }),
      execute: async (params, _config, ctx) => {
        ctx.onUpdate?.({ progress: { text: "spawning 1 sub-agent", id: "wf:spawn" } });
        const client = api.runtime.gatewayClient(); // exact accessor per api-findings.md
        const { status, output } = await spawnAwaitCollect(client, (params as { task: string }).task);
        ctx.onUpdate?.({ progress: { text: `child ${status}`, id: "wf:done" } });
        return { content: [{ type: "text", text: output }] };
      },
    });
  },
});
```

- [ ] **Step 3: Build + relink + restart**

Run:
```bash
pnpm build && openclaw gateway restart
openclaw plugins inspect workflows --runtime --json
```
Expected: `workflow` now appears in the tools list.

- [ ] **Step 4: Commit**

```bash
git add src/skeleton/spawn-bridge.ts src/index.ts
git commit -m "feat: walking-skeleton workflow tool (spawn→agent.wait→collect)"
```

### Task 0.7: First real-OpenClaw integration test (L1)

**Files:**
- Create: `src/skeleton/spawn-bridge.live.test.ts`

- [ ] **Step 1: Write the live test** (gated; drives the real Gateway)

```ts
import { describe, it, expect } from "vitest";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { spawnAwaitCollect } from "./spawn-bridge.js";

const live = process.env.OPENCLAW_LIVE_TEST === "1";

describe.skipIf(!live)("spawnAwaitCollect (live)", () => {
  it("spawns one child, awaits in-code, and collects its output", async () => {
    const client = new GatewayClient(/* opts from api-findings.md */);
    const { status, output } = await spawnAwaitCollect(
      client,
      "Reply with exactly the word: PONG",
    );
    expect(status).toBe("ok");
    expect(output.toUpperCase()).toContain("PONG");
  }, 180_000);
});
```

- [ ] **Step 2: Run it against a live gateway**

Run:
```bash
OPENCLAW_LIVE_TEST=1 pnpm test src/skeleton/spawn-bridge.live.test.ts
```
Expected: PASS — a real sub-session ran and `PONG` came back via `agent.wait` + `chat.history`. **This is the spine proof.** If it fails, debug against `api-findings.md` before Phase 1 / Plan #2.

- [ ] **Step 3: Commit**

```bash
git add src/skeleton/spawn-bridge.live.test.ts
git commit -m "test: live spine proof — spawn→await→collect on real gateway"
```

---

## Phase 1 — Pure-logic foundation (no OpenClaw; full TDD)

Every module here is OpenClaw-independent and tested without a Gateway. These are the building blocks Plan #2 wires into the orchestration runtime.

### Task 1.1: Concurrency scheduler (admission queue)

**Files:**
- Create: `src/runtime/scheduler.ts`
- Test: `src/runtime/scheduler.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { createScheduler } from "./scheduler.js";

describe("createScheduler", () => {
  it("never runs more than `limit` tasks concurrently", async () => {
    const sched = createScheduler({ limit: 4 });
    let active = 0;
    let peak = 0;
    const task = () =>
      sched.schedule(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return true;
      });
    await Promise.all(Array.from({ length: 32 }, task));
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("returns each task's result and preserves caller order", async () => {
    const sched = createScheduler({ limit: 2 });
    const results = await Promise.all([1, 2, 3].map((n) => sched.schedule(async () => n * 10)));
    expect(results).toEqual([10, 20, 30]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/runtime/scheduler.test.ts`
Expected: FAIL — `createScheduler` not found.

- [ ] **Step 3: Implement** `src/runtime/scheduler.ts`

```ts
export type Scheduler = { schedule<T>(fn: () => Promise<T>): Promise<T> };

export function createScheduler(opts: { limit: number }): Scheduler {
  const limit = Math.max(1, opts.limit);
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (active >= limit) return;
    const run = queue.shift();
    if (run) run();
  };

  return {
    schedule<T>(fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const run = () => {
          active += 1;
          fn().then(resolve, reject).finally(() => {
            active -= 1;
            next();
          });
        };
        queue.push(run);
        next();
      });
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test src/runtime/scheduler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/scheduler.ts src/runtime/scheduler.test.ts
git commit -m "feat: concurrency scheduler with admission queue"
```

### Task 1.2: Budget meter (hard ceiling)

**Files:**
- Create: `src/runtime/budget.ts`
- Test: `src/runtime/budget.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { createBudget, BudgetExceededError } from "./budget.js";

describe("createBudget", () => {
  it("tracks spend and remaining", () => {
    const b = createBudget(1000);
    b.charge(300);
    expect(b.spent()).toBe(300);
    expect(b.remaining()).toBe(700);
  });

  it("throws once the ceiling is reached (hard, not advisory)", () => {
    const b = createBudget(1000);
    b.charge(600);
    b.assertCanSpend(); // still ok
    b.charge(600); // now over
    expect(() => b.assertCanSpend()).toThrow(BudgetExceededError);
  });

  it("treats a null total as unlimited", () => {
    const b = createBudget(null);
    b.charge(10_000_000);
    expect(() => b.assertCanSpend()).not.toThrow();
    expect(b.remaining()).toBe(Infinity);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/runtime/budget.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `src/runtime/budget.ts`

```ts
export class BudgetExceededError extends Error {
  constructor(spent: number, total: number) {
    super(`Budget exceeded: spent ${spent} of ${total}`);
    this.name = "BudgetExceededError";
  }
}

export type Budget = {
  total: number | null;
  spent(): number;
  remaining(): number;
  charge(tokens: number): void;
  assertCanSpend(): void;
};

export function createBudget(total: number | null): Budget {
  let used = 0;
  return {
    total,
    spent: () => used,
    remaining: () => (total === null ? Infinity : Math.max(0, total - used)),
    charge: (tokens) => {
      used += Math.max(0, tokens);
    },
    assertCanSpend: () => {
      if (total !== null && used >= total) throw new BudgetExceededError(used, total);
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test src/runtime/budget.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/budget.ts src/runtime/budget.test.ts
git commit -m "feat: budget meter with hard ceiling"
```

### Task 1.3: Schema validate + retry runner

**Files:**
- Create: `src/runtime/schema-retry.ts`
- Test: `src/runtime/schema-retry.test.ts`

> `Validator` is a small adapter so this module stays decoupled from any specific schema lib. Plan #2 wires it to TypeBox/JSON-Schema.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { runWithSchema, type Validator } from "./schema-retry.js";

const evenNumber: Validator<number> = (text) => {
  const n = Number(text);
  if (Number.isInteger(n) && n % 2 === 0) return { ok: true, value: n };
  return { ok: false, error: `not an even integer: ${text}` };
};

describe("runWithSchema", () => {
  it("returns the validated value on first success", async () => {
    const run = vi.fn().mockResolvedValue("4");
    const result = await runWithSchema({ run, validate: evenNumber, maxRetries: 2 });
    expect(result).toBe(4);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retries with the error appended, then succeeds", async () => {
    const run = vi.fn().mockResolvedValueOnce("3").mockResolvedValueOnce("6");
    const result = await runWithSchema({ run, validate: evenNumber, maxRetries: 2 });
    expect(result).toBe(6);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0]).toContain("not an even integer");
  });

  it("returns null after exhausting retries", async () => {
    const run = vi.fn().mockResolvedValue("3");
    const result = await runWithSchema({ run, validate: evenNumber, maxRetries: 2 });
    expect(result).toBeNull();
    expect(run).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/runtime/schema-retry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `src/runtime/schema-retry.ts`

```ts
export type Validator<T> = (text: string) => { ok: true; value: T } | { ok: false; error: string };

export async function runWithSchema<T>(opts: {
  run: (correction?: string) => Promise<string>;
  validate: Validator<T>;
  maxRetries: number;
}): Promise<T | null> {
  let correction: string | undefined;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt += 1) {
    const text = await opts.run(correction);
    const checked = opts.validate(text);
    if (checked.ok) return checked.value;
    correction = `Your previous output failed validation: ${checked.error}. Return a valid result.`;
  }
  return null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test src/runtime/schema-retry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/schema-retry.ts src/runtime/schema-retry.test.ts
git commit -m "feat: schema validate+retry runner"
```

### Task 1.4: Cache key (resume journal keying)

**Files:**
- Create: `src/runtime/cache-key.ts`
- Test: `src/runtime/cache-key.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { agentCacheKey } from "./cache-key.js";

describe("agentCacheKey", () => {
  const base = { scriptHash: "abc", args: { a: 1 }, callSite: "phase:scan#3", prompt: "audit x" };

  it("is stable for identical inputs", () => {
    expect(agentCacheKey(base)).toBe(agentCacheKey({ ...base }));
  });

  it("changes when the prompt changes", () => {
    expect(agentCacheKey(base)).not.toBe(agentCacheKey({ ...base, prompt: "audit y" }));
  });

  it("changes when args change", () => {
    expect(agentCacheKey(base)).not.toBe(agentCacheKey({ ...base, args: { a: 2 } }));
  });

  it("is order-independent for args object keys", () => {
    const k1 = agentCacheKey({ ...base, args: { a: 1, b: 2 } });
    const k2 = agentCacheKey({ ...base, args: { b: 2, a: 1 } });
    expect(k1).toBe(k2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/runtime/cache-key.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `src/runtime/cache-key.ts`

```ts
import { createHash } from "node:crypto";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const body = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",");
  return `{${body}}`;
}

export function agentCacheKey(input: {
  scriptHash: string;
  args: unknown;
  callSite: string;
  prompt: string;
}): string {
  const canonical = stableStringify({
    scriptHash: input.scriptHash,
    args: input.args,
    callSite: input.callSite,
    prompt: input.prompt,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test src/runtime/cache-key.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/cache-key.ts src/runtime/cache-key.test.ts
git commit -m "feat: stable cache key for resume journal"
```

### Task 1.5: Script static-validator

**Files:**
- Create: `src/runtime/validate-script.ts`
- Test: `src/runtime/validate-script.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { validateScript } from "./validate-script.js";

describe("validateScript", () => {
  it("accepts a script that only uses the workflow primitives", () => {
    const ok = `const r = await agent("hi"); log(r); return r;`;
    expect(validateScript(ok)).toEqual({ ok: true });
  });

  it("rejects require()", () => {
    const r = validateScript(`const fs = require("fs");`);
    expect(r.ok).toBe(false);
  });

  it("rejects dynamic import and process/fs/child_process access", () => {
    expect(validateScript(`await import("fs");`).ok).toBe(false);
    expect(validateScript(`process.exit(1);`).ok).toBe(false);
    expect(validateScript(`globalThis.fetch("http://x");`).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/runtime/validate-script.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `src/runtime/validate-script.ts`

```ts
const FORBIDDEN = [
  /\brequire\s*\(/,
  /\bimport\s*\(/,
  /\bprocess\b/,
  /\bglobalThis\b/,
  /\bfetch\s*\(/,
  /\b(child_process|fs|net|http|https|os|vm)\b/,
];

export type ScriptValidation = { ok: true } | { ok: false; reason: string };

export function validateScript(source: string): ScriptValidation {
  for (const pattern of FORBIDDEN) {
    if (pattern.test(source)) return { ok: false, reason: `forbidden token: ${pattern}` };
  }
  return { ok: true };
}
```

> Note: regex is a first-pass guard, defense-in-depth alongside the vm sandbox (Task 1.6) which is the real boundary. Plan #2 may upgrade to AST-based checking.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test src/runtime/validate-script.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/validate-script.ts src/runtime/validate-script.test.ts
git commit -m "feat: script static-validator (defense-in-depth)"
```

### Task 1.6: VM sandbox runner

**Files:**
- Create: `src/runtime/sandbox.ts`
- Test: `src/runtime/sandbox.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { runScript } from "./sandbox.js";

describe("runScript", () => {
  it("exposes the injected primitives and returns the script's value", async () => {
    const agent = vi.fn().mockResolvedValue("RESULT");
    const log = vi.fn();
    const value = await runScript({
      source: `const r = await agent("hi"); log(r); return r + "!";`,
      primitives: { agent, log },
      args: undefined,
      budget: null,
    });
    expect(value).toBe("RESULT!");
    expect(agent).toHaveBeenCalledWith("hi");
    expect(log).toHaveBeenCalledWith("RESULT");
  });

  it("exposes args to the script", async () => {
    const value = await runScript({
      source: `return args.map((n) => n * 2);`,
      primitives: {},
      args: [1, 2, 3],
      budget: null,
    });
    expect(value).toEqual([2, 4, 6]);
  });

  it("denies access to host globals (process/require)", async () => {
    await expect(
      runScript({ source: `return process.pid;`, primitives: {}, args: undefined, budget: null }),
    ).rejects.toThrow();
    await expect(
      runScript({ source: `return require("fs");`, primitives: {}, args: undefined, budget: null }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/runtime/sandbox.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `src/runtime/sandbox.ts`

```ts
import { createContext, Script } from "node:vm";

export async function runScript(opts: {
  source: string;
  primitives: Record<string, unknown>;
  args: unknown;
  budget: unknown;
}): Promise<unknown> {
  // The sandbox context contains ONLY the injected primitives + args/budget.
  // No require, process, globalThis host, fs, or net is reachable.
  const sandbox: Record<string, unknown> = {
    ...opts.primitives,
    args: opts.args,
    budget: opts.budget,
  };
  const context = createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });
  // Wrap as an async IIFE so `await` and `return` work at top level.
  const wrapped = `(async () => { ${opts.source} })()`;
  const script = new Script(wrapped, { filename: "workflow-script.js" });
  return await script.runInContext(context, { timeout: 60_000 });
}
```

> Note: `codeGeneration.strings:false` blocks `eval`/`Function`. The empty context means bare identifiers like `process`/`require` throw `ReferenceError`. This is the real security boundary; Task 1.5 is the cheap pre-check.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test src/runtime/sandbox.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/sandbox.ts src/runtime/sandbox.test.ts
git commit -m "feat: node:vm sandbox runner for orchestration scripts"
```

### Task 1.7: A2UI phase-tree builder

**Files:**
- Create: `src/surface/phase-tree-a2ui.ts`
- Test: `src/surface/phase-tree-a2ui.test.ts`

> Models the OpenClaw Canvas A2UI shape (`extensions/canvas/src/a2ui-jsonl.ts`): one action key per JSONL line, `surfaceUpdate` + `beginRendering`, v0.8 dialect.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { buildPhaseTreeA2UI } from "./phase-tree-a2ui.js";

type PhaseView = { name: string; agents: Array<{ label: string; status: string }> };

describe("buildPhaseTreeA2UI", () => {
  const phases: PhaseView[] = [
    { name: "scan", agents: [{ label: "file1", status: "done" }, { label: "file2", status: "running" }] },
    { name: "verify", agents: [{ label: "claim1", status: "queued" }] },
  ];

  it("emits one JSON object per line, each with exactly one A2UI action key", () => {
    const jsonl = buildPhaseTreeA2UI(phases);
    const lines = jsonl.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const ACTIONS = ["beginRendering", "surfaceUpdate", "dataModelUpdate", "deleteSurface", "createSurface"];
    for (const line of lines) {
      const obj = JSON.parse(line);
      const keys = ACTIONS.filter((k) => k in obj);
      expect(keys.length).toBe(1);
    }
  });

  it("ends with a beginRendering action and references every phase + agent label", () => {
    const jsonl = buildPhaseTreeA2UI(phases);
    const lines = jsonl.split("\n").filter(Boolean);
    expect(JSON.parse(lines[lines.length - 1])).toHaveProperty("beginRendering");
    expect(jsonl).toContain("scan");
    expect(jsonl).toContain("verify");
    expect(jsonl).toContain("file2");
    expect(jsonl).toContain("claim1");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/surface/phase-tree-a2ui.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `src/surface/phase-tree-a2ui.ts`

```ts
export type AgentView = { label: string; status: string };
export type PhaseView = { name: string; agents: AgentView[] };

// Build A2UI v0.8 JSONL: one surfaceUpdate with a Column of phase/agent Text rows, then beginRendering.
export function buildPhaseTreeA2UI(phases: PhaseView[]): string {
  const surfaceId = "main";
  const rootId = "root";
  const rows: Array<{ id: string; component: unknown }> = [];
  const childIds: string[] = [];

  phases.forEach((phase, pi) => {
    const phaseId = `phase-${pi}`;
    childIds.push(phaseId);
    rows.push({
      id: phaseId,
      component: { Text: { text: { literalString: `▸ ${phase.name}` }, usageHint: "title" } },
    });
    phase.agents.forEach((agent, ai) => {
      const agentId = `phase-${pi}-agent-${ai}`;
      childIds.push(agentId);
      rows.push({
        id: agentId,
        component: {
          Text: { text: { literalString: `   • ${agent.label} [${agent.status}]` }, usageHint: "body" },
        },
      });
    });
  });

  const payloads = [
    {
      surfaceUpdate: {
        surfaceId,
        components: [
          { id: rootId, component: { Column: { children: { explicitList: childIds } } } },
          ...rows,
        ],
      },
    },
    { beginRendering: { surfaceId, root: rootId } },
  ];
  return payloads.map((p) => JSON.stringify(p)).join("\n");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test src/surface/phase-tree-a2ui.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/surface/phase-tree-a2ui.ts src/surface/phase-tree-a2ui.test.ts
git commit -m "feat: A2UI phase-tree builder for the Canvas panel"
```

---

## Phase 1 wrap-up

- [ ] **Run the full pure-logic suite**

Run: `pnpm test`
Expected: all Phase 1 suites green (scheduler, budget, schema-retry, cache-key, validate-script, sandbox, phase-tree-a2ui).

- [ ] **Build**

Run: `pnpm build`
Expected: clean, `dist/` populated.

---

## Definition of Done (Plan #1)

- [ ] Node 22.19+ pinned; package scaffolds, installs, builds, links, and `openclaw plugins inspect workflows` shows the plugin.
- [ ] `api-findings.md` records exact SDK specifiers + the confirmed spawn/`agent.wait`/`chat.history` call sequence + detached-task access path (spine GREEN).
- [ ] Live spine test (T0.7) passes on a real Gateway: one child spawned, awaited in-code, output collected.
- [ ] All seven Phase 1 pure modules have passing unit tests and are committed.
- [ ] `pnpm test` (pure suite) and `pnpm build` are green.

## Hand-off to Plan #2 (authored after Phase 0)

With the spine proven and `api-findings.md` populated, Plan #2 wires these modules into: the full `workflow` runtime (primitives `agent`/`parallel`/`pipeline`/`phase`/`log` over the scheduler + sandbox + budget), the detached-task background execution + typed progress + Canvas panel surface, the SQLite-KV resume journal (using the cache key), save-as-command, the approval gate, and the two acceptance scenarios (A: seeded auth-audit; B: cross-checked research) run on real OpenClaw.
