# Design: `openclaw-plugin-workflows`

> A Claude-Code-style **dynamic workflows** capability for OpenClaw, shipped as a standalone plugin (no core fork).

- **Date:** 2026-06-06
- **Status:** Approved design → ready for implementation plan (`writing-plans`)
- **Base:** [OpenClaw](https://github.com/openclaw/openclaw) (🦞 personal AI assistant; Node/TS), cloned locally at `~/projects/openclaw`
- **Fidelity bar:** [Claude Code dynamic workflows](https://code.claude.com/docs/en/workflows)

---

## 1. Context & Goal

OpenClaw is a local-first agent runtime: a Gateway control plane (WebSocket/RPC) with first-class tools, a plugin system, sessions, and multi-agent routing. Its built-in workflow tool (**Lobster**) is **sequential-only** — no parallel fan-out, no loops (loop support was explicitly rejected from core, PR #20 closed). Native sub-agent orchestration (`sessions_spawn`) is LLM-driven and turn-by-turn.

**Goal:** add the thing OpenClaw lacks — Claude Code's "dynamic workflows": *the plan moves into code*. An LLM writes a JS orchestration script; a runtime executes it in the background, fanning out many isolated sub-agents, with intermediate results living in script variables so the main context only holds the final answer. This unlocks codebase-wide sweeps, large migrations, and cross-checked research with adversarial verification — none of which OpenClaw can do today.

**Deliverable:** `openclaw-plugin-workflows`, a standalone npm plugin that registers a `workflow` tool + a JS orchestration runtime. Publishable to ClawHub. Does not modify OpenClaw core.

## 2. Non-goals (v1)

- Not forking OpenClaw core or modifying the Control UI source.
- Not replacing Lobster (sequential workflows stay; we add the parallel/dynamic engine).
- Not cross-restart resume (Claude Code itself restarts fresh; out of scope).
- Not per-stage model routing, `ultracode`-style auto-launch, or mid-run human sign-off (v2).
- Not a synthetic/mock test environment as a source of truth (see §10).

## 3. Locked decisions (with rationale)

| # | Decision | Why |
|---|----------|-----|
| Base | **OpenClaw** (lobster, Node/TS) | Matches the request; it's the platform that lacks this capability. |
| Shape | **Standalone npm plugin** (not a fork) | Plugin tools are our own Node code; can drive Gateway + sessions without touching 145k★ core; ClawHub-distributable; upgrade-safe. |
| Sub-agent execution | **Real OpenClaw sub-sessions via spawn** | OS-level isolation, native reuse of all OpenClaw tools/skills/sandboxes. |
| Result collection | **Self-built collection layer over `agent.wait`** | The gateway exposes an in-code await (`agent.wait`), so we don't depend on the LLM `sessions_yield`/announce turn. We own fan-out/join. |
| Surface | **Ride Gateway events + a Canvas A2UI panel** | All surfaces (TUI/WebChat/Chat/IM) are Gateway WS clients; one event stream renders everywhere. Canvas gives a rich phase-tree panel without forking the Control UI. |
| Run state / resume | **SQLite plugin KV** (not JSON journal) | OpenClaw core rule: runtime state/queues/checkpoints must be SQLite, not sidecar files. |
| Testing source of truth | **Real OpenClaw, real reasoning agents** | No faked-gateway "green check" counts as done. Only genuinely pure functions are unit-tested without OpenClaw. |

## 4. Architecture & data flow

```
User (any surface: TUI / WebChat / Telegram / Feishu / Control UI)
      │  "use a workflow to audit every endpoint for missing auth"
      ▼
Main-session Agent (LLM)  ── recognizes workflow task → WRITES a JS orchestration script
      ▼
┌──────────────────────────────────────────────────────────────────┐
│  Plugin: openclaw-plugin-workflows                                 │
│                                                                    │
│  ① `workflow` tool (long-running, runs in MAIN session = can spawn)│
│       │  APPROVAL GATE → user confirms phases + raw script         │
│       ▼                                                            │
│  ② Detached task (createRunningTaskRun) → main session stays free  │
│       ▼                                                            │
│  ③ JS Runtime sandbox (node:vm, no fs/shell/net)                   │
│       primitives: agent() parallel() pipeline() phase() log()      │
│       + schema / args / budget                                     │
│       │                                                            │
│       ├─ each agent() ─► Admission Queue (our scheduler, ≤target)  │
│       │       └─► gateway `agent`(lane:subagent) ─► {runId, key}    │
│       │           └─► `agent.wait(runId)` (in-code await)           │
│       │               └─► `chat.history(key)` → child final output  │
│       │                                                            │
│       ├─ progress ─► typed tool-progress (onUpdate) ─► session.tool │
│       │              stream ─► tool cards on ALL surfaces           │
│       │           ─► recordTaskRunProgressByRunId ─► task panel     │
│       │           ─► Canvas A2UI JSONL ─► phase-tree panel (drill)  │
│       │                                                            │
│       └─ results converge in script variables                      │
│  ④ completeTaskRunByRunId(result) → main session gets final answer │
│  ⑤ run journal in SQLite KV → resume = cached children, re-spawn   │
│     only missing                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### Verified core primitives (read from real source in `~/projects/openclaw`)

| Need | Real primitive | Source |
|------|----------------|--------|
| Spawn child | **`api.runtime.subagent.run({sessionKey, message, deliver:false})` → `{runId}`** (the injected plugin runtime; wraps the gateway `agent` lane:subagent RPC) | `src/plugins/runtime/types.ts` (`PluginRuntime.subagent`), verified in 2026.6.1 d.ts |
| **In-code await** | **`api.runtime.subagent.waitForRun({runId, timeoutMs})`** → `{status:"ok"\|"error"\|"timeout", error?}` | same |
| Fetch child output | **`api.runtime.subagent.getSessionMessages({sessionKey})`** → `{messages: unknown[]}` (narrow to last assistant text) | same |

> **Spike correction (2026-06-06):** an earlier draft assumed plugins call a raw `GatewayClient`/`agent.wait`/`chat.history`. Verified: in-gateway plugins use the injected **`api.runtime.subagent`** surface above; `GatewayClient` (`openclaw/plugin-sdk/gateway-runtime`) is only for out-of-process CLI/test clients. See `docs/superpowers/plans/api-findings.md`.
| Background long task | `createRunningTaskRun` → `recordTaskRunProgressByRunId` → `completeTaskRunByRunId`/`failTaskRunByRunId`; `registerDetachedTaskRuntime(pluginId, runtime)` to own lifecycle | `src/tasks/detached-task-runtime.ts` |
| Plugin → gateway/runtime | `api.runtime` (`PluginRuntime`); `src/plugin-sdk/gateway-runtime.ts`; agent-harness runtimes | `src/plugins/api-builder.ts`, `src/plugin-sdk/*` |
| Canvas panel | A2UI JSONL via `buildA2UITextJsonl` (structured data, browser-renderable) | `extensions/canvas/src/a2ui-jsonl.ts` |

### Confirmed concurrency caps (`src/config/agent-limits.ts`, all configurable)

- `DEFAULT_AGENT_MAX_CONCURRENT = 4`
- `DEFAULT_SUBAGENT_MAX_CONCURRENT = 8`
- `DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT = 5`
- `DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 1`

Raised at install via doctor migration on `agents.defaults.subagents.{maxConcurrent,maxChildrenPerAgent}`; **our own admission queue self-limits** regardless of config.

## 5. Programming model (script API — mirrors Claude Code)

The LLM writes a JS script using:

- `agent(prompt, {schema?, label?, phase?, model?})` — spawn one sub-agent; with `schema` returns a validated object (retry-on-mismatch), else the final text. Returns `null` on failure.
- `parallel([thunks])` — **barrier**: starts all, resolves after all settle, order preserved; a throwing thunk → `null`.
- `pipeline(items, ...stages)` — **no-barrier streaming**: each item flows through all stages independently; wall-clock = slowest single chain.
- `phase(name)` / `log(msg)` — grouping + narration for the progress tree.
- Globals: `args` (caller input), `budget` (token ceiling; throws when exceeded).

**Sandbox:** `node:vm` (or `isolated-vm`), **no fs / shell / net**. The *only* IO is via the injected primitives, which call our host bridge → Gateway. This is both the security boundary and the "plan moves into code" guarantee.

## 6. Execution + self-collection layer (the new core)

1. `spawnChild(task, opts)` → gateway `agent` (lane:subagent) → `{runId, childSessionKey}`.
2. `awaitChild(runId, timeoutSeconds)` → `agent.wait` → terminal status.
3. `collectResult(childSessionKey)` → `chat.history` → final text; if `schema`, validate; on mismatch re-spawn with the validation error appended (≤2 retries); still failing → `null`.
4. **Admission queue:** concurrency = `min(target=16, configured)`; respects `maxChildrenPerAgent`; total run cap 1000.
5. Failure semantics: a failed/errored/timed-out child → `agent()` returns `null`; run continues; `.filter(Boolean)` is the documented pattern.
6. Depth constraint: our orchestrator runs in the **main session** (depth 0) and spawns depth-1 children; children cannot spawn (depth-1 default) — equals Claude Code's one-level `workflow()` nesting. A workflow `agent()` task therefore cannot itself use `sessions_spawn`.

## 7. Surface / progress layer

- **Typed tool-progress** (tool `execute(id, params, signal, onUpdate)` → `onUpdate`) → renders as live tool cards on TUI / WebChat / Chat / IM. Asserted in tests as plain progress objects.
- **Detached-task progress** (`recordTaskRunProgressByRunId`) → the task panel below the input box.
- **Canvas A2UI phase-tree panel** (`buildA2UITextJsonl`) → lives in the Control UI; drill into phase → agents → an agent's prompt/recent-calls/result. Pause/resume/stop = task cancel + our scheduler cooperating. Restart-single-agent is v2 (v1 = stop only).
- **IM channels** → throttled milestone pings (start / phase transition / done + final report); edit-in-place where the channel supports it.

## 8. Resume / Save / Approval

- **Resume:** run journal in **SQLite plugin KV**, keyed by `(scriptHash, args, callSite)`. On resume, completed `agent()` calls return cached results (0 re-spawns); only missing children run. Same-session only.
- **Approval gate:** before *any* spawn, show planned phases + raw script; deny = 0 spawns. Mirrors Claude Code's per-run approval.
- **Save:** persist a run's script as a reusable command + `args` passing. Exact OpenClaw command/skill save location confirmed during planning (candidate: a ClawHub skill / OpenClaw command).

## 9. Constraints & risks from real source (resolve in plan / Phase-0 spike)

- **SQLite-only state** — no JSON/JSONL sidecars for run state, journal, or cache (core rule). Use shared state DB / plugin KV.
- **No core imports** — plugin prod code must not import core `src/**`; only `openclaw/plugin-sdk/*`, manifest, injected runtime. ✅ RESOLVED (spike): the spine is the injected **`api.runtime.subagent`** (`run`/`waitForRun`/`getSessionMessages`); TypeBox `Type` comes from the `typebox` package directly (the SDK does not re-export it). See `api-findings.md`.
- ⚠️ **Live-env version skew (discovered in build/verify run):** the user's running gateway is `openclaw@2026.1.30` (an end-user build whose `dist/plugin-sdk/` ships only `index.js` — no `tool-plugin`/`plugin-entry` modules) while plugin authoring needs `openclaw@2026.6.1`. So a plugin **cannot load on the 2026.1.30 gateway**, and its older config schema differs. Live verification requires a matching plugin-author gateway build (see §10 / live blocker).
- **Depth-1 / maxChildren=5 / maxConcurrent=8** — must raise via doctor and self-limit; verify our orchestrator (main session) actually gets spawn capability.
- **No hot reload** — installed plugin changes need `openclaw gateway restart`; push fast feedback to the pure-unit layer.
- **Toolchain parity** — TS ESM strict, Vitest (never raw `vitest`), `oxfmt` (not Prettier), `tsgo` (not `tsc`), Node 22.19+/24.

## 10. Testing & Acceptance

**Principle: real OpenClaw with real reasoning agents is the only source of truth.** No faked-gateway result counts as "done." Only genuinely pure functions run without OpenClaw.

### Layers

- **L0 — Pure-unit (no OpenClaw, ms, every change):** A2UI JSONL builder output, cache-key hasher, script static-validator (rejects fs/shell/net), budget + admission-queue bookkeeping as a pure state machine. These test *our* logic; there is no OpenClaw behavior to fake.
- **L1 — Structural correctness on real Gateway + real agents:** assert **orchestration observables**, not agent content (content-independent ⇒ deterministic despite nondeterministic agents):
  - peak concurrent in-flight sub-sessions ≤ target (subscribe to real session lifecycle) — an always-true upper bound, not flaky;
  - `parallel` resolves only after all children reach terminal state;
  - `pipeline` interleaving via deliberately size-skewed tasks (fast item in stage 2 while slow item still in stage 1, by real session timestamps);
  - resume re-spawns 0 completed children (count real spawn RPCs);
  - forced child failure → `agent()` returns `null`, run continues;
  - typed progress emitted on every lifecycle transition (subscribe to real `session.tool`);
  - main session responsive (second message answered mid-run).
- **L2 — E2E acceptance scenarios (DoD gate), real agents + seeded fixtures:** content-dependent ⇒ thresholds + multi-run majority; gated behind `OPENCLAW_LIVE_TEST=1`, nightly/on-demand.
- **L3 — Manual surface demo:** Canvas phase-tree in a real browser; tool cards in TUI + WebChat + one IM channel; screenshot-verify. Where automation is impossible, say "cannot auto-verify" — never pretend.

**Cost / flake control:** small model (`sonnet-4.6`/haiku tier) + small N for L1/L2; all real-agent tests gated behind `OPENCLAW_LIVE_TEST=1`, run nightly/on-demand, not on every push; estimate cost on a small slice first. L0 is the only fast inner loop.

**Commands:** `pnpm test <file>`; live via `OPENCLAW_LIVE_TEST=1`; manual via `openclaw plugins install --link ./` + `openclaw gateway restart`, then drive like a user.

### Acceptance rubric (6 dimensions)

Each criterion is `{asserts | verified by | threshold | MVP?}` — full table maintained in the plan. Dimensions: **(1) primitive correctness** (parallel barrier, pipeline no-barrier, schema validate+retry, budget hard ceiling, args), **(2) execution semantics** (real spawn, isolation, concurrency cap, total cap, in-code collection, failure→null), **(3) surface/progress** (typed events, tool cards ≥2 surfaces, Canvas live + drill + pause/resume), **(4) reliability** (resume cache 100% on completed, graceful failure modes, cost bounded by caps), **(5) quality patterns** (adversarial-verify kills a planted false positive), **(6) authoring** (LLM writes sandbox-legal script, approval gate, save+args round-trip, children can't spawn).

### Canonical acceptance scenarios (real OpenClaw)

**Scenario A — seeded auth-audit with adversarial filtering.** Fixture repo, 12 files under `src/routes/`, **4 planted missing-auth bugs** + **1 plausible-but-safe "trap"**. Oracle:
- recall over planted set = **4/4**;
- the trap is **adversarially filtered out** of the final report (≥1 false positive killed by verification);
- precision on the final report = **4/4** (no surviving false positives);
- peak concurrency ≤ target; total agents ≤ 1000;
- stop after the scan phase → resume re-spawns **0** completed agents.
- **FAIL** if any planted bug is missed, the trap survives, concurrency is exceeded, or resume re-spawns a completed agent. (Recall/precision judged over runs; thresholds finalized in plan.)

**Scenario B — cross-checked research.** A question with a citation-checkable ground truth and **≥2 planted contradictory sources** (fixture pages). Oracle:
- final answer matches ground truth on the checkable fact;
- the false claim is filtered out by cross-check voting;
- every surviving claim carries ≥1 citation (100% coverage);
- pipeline interleaving observed (proves no-barrier);
- caps + budget honored.
- **FAIL** if the false claim survives as asserted, any surviving claim is uncited, or the pipeline degenerated to a barrier.

### Definition of Done (v1)

All of: rubric dimensions 1–6 pass (with restart-single-agent as v2 / stop-only in v1); Scenario A passes its full oracle; Scenario B passes its full oracle; Canvas panel + tool cards verified on ≥2 surfaces (L3).

### v2 (explicitly out of v1)

Restart-individual-agent from Canvas; tool cards on *all* surfaces; cross-restart resume; per-stage model routing + per-stage budgets; `ultracode`-style auto-launch; mid-run human sign-off; adversarial-verify as a reusable bundled library; run-vs-run script diff.

## 11. Engineering setup

- **Repo:** `~/projects/openclaw-plugin-workflows` — npm package, TS ESM strict, Vitest, `oxfmt`, `tsgo`. Dev-linked to `~/projects/openclaw`.
- **Stage:** 0→1 scaffold — commit to `main`, single editing entry, no worktrees. Push to GitHub later.
- **Deferred to implementation:** Node bump (current 22.18.0 < required 22.19.0), `pnpm install` of the OpenClaw monorepo, running the Gateway for live acceptance, disk headroom (~13 GB free).
```
