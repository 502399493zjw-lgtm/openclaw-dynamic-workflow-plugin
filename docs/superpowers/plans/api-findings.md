# OpenClaw plugin-SDK API findings (verified against real install)

Spike output for Plan #1 Task 0.2 / 0.5 / 0.6 / 0.7. Every value below was copied
from real files, not guessed. Two distinct OpenClaw artifacts exist on this machine;
the distinction is load-bearing, so it is documented first.

## 0. Environment reality (CRITICAL — two different OpenClaw builds)

| Artifact | Where | Version / commit | Plugin-SDK subpaths usable? |
| --- | --- | --- | --- |
| **Running gateway CLI** (LaunchAgent on :18789) | `~/.stepfun/runtimes/node/.../lib/node_modules/openclaw/dist/index.js` | `2026.1.30` (`76b5208`) | **NO** — `dist/plugin-sdk/` ships only `index.js`; `tool-plugin`/`plugin-entry`/`gateway-runtime` modules and all `*.d.ts` are absent. `defineToolPlugin`/`definePluginEntry` exist nowhere in that dist. |
| **npm package resolved in our `node_modules`** | `node_modules/openclaw -> .pnpm/openclaw@2026.6.1/...` | `2026.6.1` | **YES** — 319 export subpaths, explicit `./plugin-sdk/tool-plugin`, `./plugin-sdk/plugin-entry`, `./plugin-sdk/gateway-runtime` each with `types` + `default`; 2700 `.d.ts` files. This is a proper plugin-author distribution. |
| **Source clone (read-only, for signatures)** | `~/projects/openclaw` | HEAD `d4b4a65` (diverged from both) | source of truth for `.ts` signatures |

We build/typecheck against `openclaw@2026.6.1` (full SDK). The **live gateway runs
`2026.1.30`**, which cannot resolve `openclaw/plugin-sdk/tool-plugin` at runtime.
This is the root cause of the live-load + live-test blockers recorded below.

## 1. Entry-point import specifiers (source: docs/plugins/sdk-entrypoints.md + 2026.6.1 exports)

- `defineToolPlugin`  → `import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";`
- `definePluginEntry` → `import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";`
- `defineChannelPluginEntry` / `defineSetupPluginEntry` → `openclaw/plugin-sdk/channel-core`
- TypeBox `Type`: the SDK does **not** re-export it. Use the `typebox` package directly:
  `import { Type } from "typebox";` (docs example uses exactly this). `openclaw@2026.6.1`
  depends on `typebox@1.1.39`; `tool-plugin.d.ts` itself does `import { Static, TSchema } from "typebox"`.
  `typebox` is NOT hoisted to our project root, so it must be a **direct dependency** of our
  package (added at `typebox@1.1.39` to match the SDK).
- `GatewayClient`     → `import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";`
  (re-exported there from `../gateway/client.js`).

## 2. Tool registration shape (source: src/plugin-sdk/tool-plugin.ts, verified in 2026.6.1 d.ts)

`defineToolPlugin` is the clean path (auto-derives `contracts.tools` manifest metadata):

```ts
defineToolPlugin({
  id, name, description,
  configSchema?: TSchema,
  tools: (tool) => [
    tool({
      name, label?, description,
      parameters: Type.Object({...}),
      execute: (params, config, context) => unknown, // plain value → wrapped as text/json result
    }),
  ],
});
```

`ToolPluginExecutionContext` (the 3rd `execute` arg) =
`{ api: OpenClawPluginApi; signal?: AbortSignal; toolCallId: string; onUpdate?: AgentToolUpdateCallback }`.

Lower-level `definePluginEntry` + `api.registerTool(tool, opts?)` exists too, but `registerTool`
takes a full `AgentTool` (NOT the plan's `{parameters, execute}` object literal): its `execute`
signature is `(toolCallId, params, signal?, onUpdate?) => Promise<AgentToolResult<T>>` and the
result must carry both `content` and `details`. `defineToolPlugin` wraps all of that, so we use it.

## 3. The spine accessor — api.runtime.subagent (NOT a raw GatewayClient)

PLAN PLACEHOLDER WAS WRONG. The plan skeleton used `api.runtime.gatewayClient()` +
`client.call("agent",...)` / `"agent.wait"` / `"chat.history"`. **No `gatewayClient()`
accessor exists on the injected runtime.** The real in-gateway spine
(`src/plugins/runtime/types.ts`, identical in 2026.6.1 `types-BkfH_k6C.d.ts`):

`api.runtime` is typed `PluginRuntime`, which includes:

```ts
api.runtime.subagent: {
  run: (p: { sessionKey: string; message: string; provider?; model?; extraSystemPrompt?;
             lane?: string; lightContext?: boolean; deliver?: boolean; idempotencyKey?: string })
       => Promise<{ runId: string }>;
  waitForRun: (p: { runId: string; timeoutMs?: number })
       => Promise<{ status: "ok" | "error" | "timeout"; error?: string }>;
  getSessionMessages: (p: { sessionKey: string; limit?: number })
       => Promise<{ messages: unknown[] }>;   // element type is unknown → narrow defensively
  deleteSession: (p: { sessionKey: string; deleteTranscript?: boolean }) => Promise<void>;
}
```

Confirmed call sequence (spine): `subagent.run({ sessionKey, message, deliver:false })`
→ `subagent.waitForRun({ runId, timeoutMs })` → `subagent.getSessionMessages({ sessionKey })`,
then take the last assistant message's text. `getSessionMessages` returns `messages: unknown[]`,
so the bridge narrows each entry to `{ role?, content? }` and joins `content[].text`.

`sessionKey` convention (from sdk-runtime.md examples): `agent:<agentId>:subagent:<name>`.
Model overrides (`provider`/`model`) require operator opt-in
(`plugins.entries.workflows.subagent.allowModelOverride: true`); omit them to run with defaults.

`GatewayClient` (`openclaw/plugin-sdk/gateway-runtime`) is the OUT-OF-PROCESS client (CLI/test);
inside the gateway, plugins use the injected `api.runtime.subagent`, not a fresh client.

## 4. onUpdate progress shape (source: packages/agent-core/src/types.ts)

`AgentToolUpdateCallback<T> = (partialResult: AgentToolResult<T>) => void`.
`AgentToolResult<T> = { content: (TextContent|ImageContent)[]; details: T; progress?: AgentToolProgress; terminate?: boolean }`.
`AgentToolProgress = { text: string; visibility: "channel"; privacy: "public"; id?: string }`.

So progress emission is NOT `{ progress: { text, id } }` (plan placeholder). The supported helpers
(`src/agents/tools/common.ts`) are `emitToolProgress(onUpdate, { text, id? })` and
`toolProgressResult({ text, id? })` (`PublicToolProgress = Pick<AgentToolProgress,"text"|"id">`),
which fill in `visibility:"channel"` / `privacy:"public"`. With `defineToolPlugin`'s `context.onUpdate`,
emit via the full result shape: `onUpdate({ content: [], details: undefined, progress: { text, visibility:"channel", privacy:"public", id } })`.

## 5. Manifest + package fields (source: docs/plugins/sdk-entrypoints.md)

`package.json` `openclaw` block for an installed package:
`{ "extensions": ["./src/index.ts"], "runtimeExtensions": ["./dist/index.js"] }` (runtime entry
required for installed npm packages; missing `runtimeExtensions` fails discovery). `openclaw.plugin.json`
needs `id` (must match the entry id) + name/description; `contracts.tools` is derived by
`openclaw plugins build` from `defineToolPlugin`, but we keep a hand-written one for clarity.

## 6. CLI commands — installed 2026.1.30 CLI does NOT match the plan

`openclaw plugins --help` on the running CLI lists: `list, info, enable, disable, install, update, doctor`.
There is **no `inspect` subcommand** and `install` has **no documented `--link` flag** on `2026.1.30`.
The plan's `openclaw plugins install --link` + `openclaw plugins inspect workflows --runtime --json`
are from the newer source CLI, not this installed build. Gateway restart is `openclaw gateway restart`.

## 7. Verdict

- Build/typecheck spine: **GREEN** against `openclaw@2026.6.1` (types resolve, signatures verified).
- Live load + spine: **PROVEN on an isolated 2026.6.1 dev gateway** (see §8). The plugin loads and the
  `workflow` tool registers on a real 2026.6.1 gateway; the spawn→await→collect spine executes end-to-end
  up to the real LLM call. Only the final PONG is blocked by a stale/placeholder model credential (external).
- The user's *production* gateway runs `2026.1.30` (StepFun-managed, end-user build) which cannot host
  plugins; do not target it. Live work uses the isolated 2026.6.1 dev gateway.

## 8. Live verification on an isolated 2026.6.1 dev gateway (2026-06-06)

Stood up `openclaw@2026.6.1` (from our `node_modules`) under an isolated `OPENCLAW_HOME`
(`.devgateway/home`) on **port 18790**, with a downloaded `node-v22.19.0` (2026.6.1 refuses Node 22.18).
Production gateway (:18789, `~/.openclaw`, the LaunchAgent, `~/.stepfun`) was never touched. Results:

- **Config migration to 2026.6.1 — verified delta:** `ModelsConfigSchema` (`src/config/zod-schema.core.ts`)
  is `.strict()` and permits only `{mode, providers, pricing}`. The ONLY rejection was
  `models: Unrecognized key: "bedrockDiscovery"`. **Fix = delete `models.bedrockDiscovery`** (it moved to its
  own config surface). The custom `moonshot` provider block needed NO change because `moonshot` is a
  **built-in overlay id** (`BUILT_IN_MODEL_PROVIDER_OVERLAY_IDS`) — only truly-custom provider ids must
  declare `baseUrl`+`models`. Also: port→18790, removed `channels.feishu` + its plugin entries, repointed
  `agents.defaults.workspace` into the isolated home. → `openclaw config validate` = `Config valid`.
- **Plugin loads on 2026.6.1:** `openclaw plugins inspect workflows` → `Status: loaded` (enabled, no
  diagnostics). The `workflow` tool is confirmed present via the model-free `tools.catalog` RPC
  (`{includePlugins:true}`) — 1 of 42 tools. (`plugins inspect --json` reports `tools: []`, but that is a
  known metadata limitation — the bundled `memory-core` plugin reports the same.)
- **Spine executes end-to-end:** the `workflow` skeleton spawned a real sub-agent, awaited it in code, and
  routed to `moonshot/kimi-k2.5` — reaching the real LLM HTTP call. Two 2026.6.1 client-contract deltas were
  needed and are now in the live test:
  - `callGatewayFromCli` with a URL override requires an **explicit token** (`ensureExplicitGatewayAuth`);
    pass `OPENCLAW_GATEWAY_TOKEN`.
  - `AgentParamsSchema` (`packages/gateway-protocol/src/schema/agent.ts`) now requires
    **`idempotencyKey: NonEmptyString`** (`additionalProperties:false`).
- **Live PONG — ✅ PASSED.** With a valid Moonshot/Kimi key (`models.providers.moonshot`, `api.moonshot.cn/v1`),
  the live spine test passed on **`moonshot/kimi-k2.6`** (and `kimi-k2.5`): a real sub-agent spawned, was
  awaited in code via `agent.wait`, and returned `PONG`. One final 2026.6.1 contract delta was needed:
  **`chat.history` requires `sessionKey`** (it rejects the older `key` param). The live-test adapter now
  sends `{ sessionKey }`.
- **Credential notes (transient, not design):** the original `~/.openclaw` moonshot key was stale (401 — the
  StepFun prod gateway injects a live credential at runtime). A magic666 NewAPI key worked for auth but its
  Claude **opus** models are quota-rate-limited (`api.magic666.top` is the real API host; `www`/bare → 403 WAF).
  The Moonshot/Kimi key has no such limit, so it landed the PONG.

**Bottom line — Phase 0 spine fully proven on a real openclaw@2026.6.1 gateway:** plugin loads + the
`workflow` tool registers + spawn→await-in-code→collect returns a real LLM `PONG`. Production gateway
(StepFun-managed :18789) was never touched throughout. The three 2026.6.1 contract deltas (explicit
gateway token on URL override; required `idempotencyKey`; `chat.history` uses `sessionKey`) are captured
above for Plan #2.

## 9. Plan #3 mechanisms (read-only source verification vs openclaw HEAD d4b4a65 + installed 2026.6.1 d.ts)

All file:line refs below are the real OpenClaw source unless prefixed `dist/` (the installed
`node_modules/openclaw` 2026.6.1 build). Each mechanism was confirmed present in the 2026.6.1 d.ts too.

### 9.1 Detached / background execution — **PARTIAL (workaround required)**

**The raw detached-task lifecycle exists but is NOT plugin-facing.** `createRunningTaskRun`,
`recordTaskRunProgressByRunId`, `completeTaskRunByRunId`, `failTaskRunByRunId` are core internals:

- `src/tasks/task-executor.ts:117` `createRunningTaskRun(params: DetachedRunningTaskCreateParams): TaskRecord | null`
- `src/tasks/task-executor.ts:162` `recordTaskRunProgressByRunId(params: {runId; runtime?; sessionKey?; lastEventAt?; progressSummary?; eventSummary?})`
- `src/tasks/task-executor.ts:173` `completeTaskRunByRunId(params: {runId; ...; endedAt; terminalSummary?; terminalOutcome?})`
- `src/tasks/task-executor.ts:193` `failTaskRunByRunId(params: {runId; ...; endedAt; error?; terminalSummary?})`
- Re-exported through `src/tasks/detached-task-runtime.ts:78/90/110/116` (the `getDetachedTaskLifecycleRuntime()` indirection).
- Param contract: `src/tasks/detached-task-runtime-contract.ts:14-150` (`DetachedTaskLifecycleRuntime`).

These are imported via relative `../../tasks/...` paths (see the canonical consumer
`src/agents/tools/media-generate-background-shared.ts:12-17`), which the plugin boundary forbids:
extensions may import only `openclaw/plugin-sdk/*` (per `extensions/CLAUDE.md`). There is **no
`openclaw/plugin-sdk/tasks` export** (verified absent in the 2026.6.1 `package.json` `exports`) and
**no `api.runtime.tasks.createRunningTaskRun`** — the plugin-facing `tasks` accessor
(`src/plugins/runtime/types-core.ts:329`, type `src/plugins/runtime/runtime-tasks.types.ts:64`) only
exposes read/query surfaces (`runs`/`flows` = get/list/findLatest/resolve/cancel) plus `managedFlows`.

`registerDetachedTaskRuntime(pluginId, runtime)` (`src/tasks/detached-task-runtime.ts:57`) is for an
**implementor** that wants to REPLACE the task-ledger backend (e.g. the codex native-subagent mirror),
not for a consumer that wants to spawn one background job. Irrelevant to us.

**What a `defineToolPlugin` tool actually returns to mean "running in background":** there is no
core-enforced "detached" return contract. The convention (`media-generate-background-shared.ts:320-356`,
`buildMediaGenerationStartedToolResult`) is to return a normal tool result immediately with
`details: { async: true, status: "started", taskId, runId }` plus text telling the model not to re-call
and to wait for a completion event. The background work runs in a fire-and-forget microtask
(`createDefaultMediaGenerateBackgroundScheduler`, line 306) and later "wakes" the requester session via
`deliverSubagentAnnouncement(...)`. The main session is responsive because `execute` already returned.

**Realistic plugin-facing workaround (sanctioned, GREEN):**
1. **`api.runtime.tasks.managedFlows`** — durable multi-step flow state in SQLite, fully plugin-facing.
   `api.runtime.tasks.managedFlows.fromToolContext(ctx)` →
   `createManaged({controllerId, goal})` / `runTask({...})` / `setWaiting({flowId, expectedRevision,
   currentStep, stateJson, waitJson})` / `resume` / `finish` / `fail` / `requestCancel`.
   Full type: `src/plugins/runtime/runtime-taskflow.types.ts:71-139` (`BoundTaskFlowRuntime`). This is the
   ledger entry + progress journal the UI/`tasks` views read.
2. **`api.session.workflow.scheduleSessionTurn(...)`** for the wakeup/deferred-continuation.
   `src/plugins/types.ts:2549`; params `src/plugins/host-hooks.ts:276`
   `PluginSessionTurnScheduleParams = ({at|delayMs|cron}) & {sessionKey; message; agentId?;
   deliveryMode?: "none"|"announce"; name?; tag?; deleteAfterRun?}` → returns
   `PluginSessionSchedulerJobHandle`. Cron owns timing and **creates the task ledger entry when the turn
   runs**. The sdk-runtime doc explicitly says Task Flow "is not a scheduler — use Cron or
   `scheduleSessionTurn(...)` for future wakeups" (`docs/plugins/sdk-runtime.md:262-265`).
3. Return immediately from `execute` with `details:{ async:true, status:"started", flowId }` + a
   "wait for the scheduled turn" text, mirroring the media pattern.

Gotcha: to wake/announce back to the user you must carry `deliveryContext`/`requesterOrigin` from the
tool ctx; `managedFlows` and `scheduleSessionTurn` both take a session key, not raw user input.

### 9.2 Plugin KV / SQLite persistence — **PARTIAL (hard runtime gate for third-party plugins)**

**API exists and is exactly what we want — but is gated to bundled/trusted plugins in 2026.6.1.**

- Accessor: `api.runtime.state.openKeyedStore<T>(options)` and `openSyncKeyedStore<T>(options)`.
  Type: `src/plugins/runtime/types-core.ts:310-328`.
- Store contract: `src/plugin-state/plugin-state-store.types.ts:11-48`:
  `register(key, value, {ttlMs?})` / `registerIfAbsent(...)→Promise<boolean>` (atomic dedupe) /
  `update?(key, fn, {ttlMs?})` / `lookup(key)→Promise<T|undefined>` / `consume(key)` / `delete(key)` /
  `entries()` / `clear()`. Options: `{namespace, maxEntries, defaultTtlMs?}`.
- Persists to the **shared state SQLite** (`src/plugin-state/plugin-state-store.sqlite.ts`),
  isolated per runtime-bound plugin id; survives restarts. Limits: maxEntries/namespace, 6000 live
  rows/plugin, JSON values <64KB, optional TTL (`docs/plugins/sdk-runtime.md:509-531`).

**The gate (the blocker):** the real `openKeyedStore` is supplied by a per-plugin runtime Proxy in
`src/plugins/registry.ts:2619-2654`, which calls `assertPluginStateAllowed()`:
```
if (record?.origin !== "bundled" && record?.trustedOfficialInstall !== true)
  throw new Error("openKeyedStore is only available for trusted plugins in this release.");
```
(`src/plugins/registry.ts:2625-2628`). The base runtime stub also throws
"only available through the plugin runtime proxy" (`src/plugins/runtime/index.ts:254`). The doc carries
the matching `<Warning>Bundled plugins only in this release.</Warning>` (`docs/plugins/sdk-runtime.md:530`).
So an externally-installed `workflows` plugin will throw at first `openKeyedStore(...)` call.

**Sanctioned alternative for a resume journal (GREEN):** use **`api.runtime.tasks.managedFlows`** — its
`stateJson` / `waitJson` fields (`ManagedTaskFlowCreateParams`, `setWaiting`/`resume`/`finish`,
`runtime-taskflow.types.ts:36-114`) are durable SQLite-backed JSON owned by the flow, with optimistic
`expectedRevision` concurrency. That IS a journal and is NOT trust-gated. Per CLAUDE.md storage policy,
do NOT introduce a JSON/JSONL sidecar; a dedicated plugin-owned SQLite schema is the only other
sanctioned route if flow `stateJson` is insufficient.

### 9.3 Canvas push from a plugin/tool — **YES (GREEN, but targets a paired node, not a server surface)**

A2UI is pushed by invoking a **node-host command** through the Gateway. There is no server-side canvas
surface — the canvas runs on a paired node (`extensions/canvas/openclaw.plugin.json:8` "for paired
nodes"; node commands list `extensions/canvas/index.ts:13-22`).

- The canvas tool calls `invoke("canvas.a2ui.pushJSONL", { jsonl })` and `("canvas.a2ui.reset")`
  (`extensions/canvas/src/tool.ts:210,214`), where `invoke` =
  `callGatewayTool("node.invoke", gatewayOpts, { nodeId, command, params, idempotencyKey })`
  (`extensions/canvas/src/tool.ts:112-118`).
- `callGatewayTool<T>(method, opts: {gatewayUrl?; gatewayToken?; timeoutMs?}, params?, extra?)` is
  exported at `openclaw/plugin-sdk/agent-harness-runtime` (`src/plugin-sdk/agent-harness-runtime.ts:113`
  → def `src/agents/tools/gateway.ts:192`). It resolves least-privilege operator scopes itself.
- **The plugin-facing equivalent (preferred for us):** `api.runtime.nodes.invoke({ nodeId, command,
  params, timeoutMs?, idempotencyKey? })` — type `src/plugins/runtime/types.ts:90-93`; documented at
  `docs/plugins/sdk-runtime.md:240-256`. Inside the Gateway it is in-process; from plugin CLI it goes
  over RPC. NB: `nodes.invoke` throws "only available inside the Gateway" if the runtime isn't
  gateway-bound (`src/plugins/runtime/index.ts:203-211`) — fine for a tool executing in the gateway.
- Payload: `command: "canvas.a2ui.pushJSONL"`, `params: { jsonl }` where `jsonl` is newline-joined A2UI
  messages. Build it with `buildA2UITextJsonl(text)` / validate with `validateA2UIJsonl(jsonl)`
  (`extensions/canvas/src/a2ui-jsonl.ts:16,44`); surface is `"main"`; supports v0.8 `surfaceUpdate` +
  `beginRendering` (line 20-39). Live-update = push successive `surfaceUpdate` JSONL frames.

Gotchas: (a) the **canvas plugin must be installed AND a node must be paired and present** the canvas
(`canvas.present` first); resolve the node via `api.runtime.nodes.list({connected:true})`. (b) Node
commands go through pairing + `gateway.nodes.allowCommands` allowlists + node-invoke policy. (c) There is
no direct in-gateway A2UI renderer to push to without a node.

### 9.4 Save-as-command / reusable workflow — **PARTIAL (no runtime registration; declare-at-load only)**

A plugin **can** own commands, but ONLY by declaring them at plugin-registration time (process-stable),
not by persisting a new invokable command at tool-execute time.

- Plugin command declaration: `OpenClawPluginCommandDefinition` (`src/plugins/types.ts:2044-2087`):
  `{name, nativeNames?, description, channels?, acceptsArgs?, requireAuth?, requiredScopes?,
  agentPromptGuidance?, handler: PluginCommandHandler}`. Handler ctx → `PluginCommandResult`
  (`src/plugins/types.ts:2018`). Args are parsed via the command-registry helpers
  (`buildCommandTextFromArgs`/`parseCommandArgs`/`serializeCommandArgs`/`resolveCommandArgMenu`),
  exported at `openclaw/plugin-sdk/native-command-registry` (`src/plugin-sdk/native-command-registry.ts:4-22`).
- These are gateway-metadata which the architecture treats as **process-stable**: "changes require
  restart or explicit owner reload/install/doctor flow" (root `AGENTS.md` / plugins `CLAUDE.md`). There
  is no `api.registerCommand(...)` callable from inside a running tool.
- `openclaw/plugin-sdk/skills-runtime` is NOT a skill-registration API — it only exposes snapshot
  invalidation listeners (`src/plugin-sdk/skills-runtime.ts:4-10`). No saved-script store is exposed.

**Realistic approach (GREEN within the plugin's own surface):** persist the saved workflow definition
as a record (in a managedFlow `stateJson`, or a plugin-owned SQLite table if KV stays trust-gated), and
expose **one static `workflow` tool param** like `{ action: "run-saved", id, args }` that loads the
stored script and replays it. The saved workflow becomes "invokable later with args" via that single
declared tool/command, not via dynamically minting a brand-new command name. If a real `/slash` command
is wanted, declare a fixed `OpenClawPluginCommandDefinition` with `acceptsArgs:true` whose handler
dispatches by a stored id from args.

### 9.5 Approval gate — **YES for pre-execute gating (GREEN); NO for true mid-execute blocking**

Two distinct surfaces exist:

**(a) The sanctioned plugin path — a `before_tool_call` hook returning `requireApproval` (GREEN).**
`api.on("before_tool_call", async (event) => ({ requireApproval: {...} }))`
(`docs/plugins/plugin-permission-requests.md:36-75`). Result type
`PluginHookBeforeToolCallResult.requireApproval` = `{ title; description; severity?:
"info"|"warning"|"critical"; timeoutMs?; timeoutBehavior?: "allow"|"deny"; allowedDecisions?:
Array<"allow-once"|"allow-always"|"deny">; pluginId?; onResolution?(decision) }`
(`src/plugins/hook-types.ts:556-565`). OpenClaw creates a `plugin:`-prefixed pending approval, delivers
it to approval surfaces, **blocks the tool call until resolved**, then continues or returns a denied
tool result (`docs/plugins/plugin-permission-requests.md:90-116`). Decisions:
`allow-once`/`allow-always` continue, `deny`/timeout(default)/cancel/no-route block. This gates a tool
(including our own `workflow` tool) BEFORE its `execute` runs — the natural place for a Plan #3 gate.

**(b) The raw gateway RPC backing it (`plugin.approval.*`).** Server methods
`src/gateway/server-methods/plugin-approval.ts:36-198`: `plugin.approval.request` (blocking — resolves
when the user decides), `plugin.approval.waitDecision`, `plugin.approval.resolve`, `plugin.approval.list`.
Request params: `{pluginId?, title, description, severity?, toolName?, toolCallId?, allowedDecisions?,
agentId?, sessionKey?, turnSource*?, timeoutMs?, twoPhase?}` (line 53-69); IDs are always server-minted
(line 98-100). Timeouts: default 120s, max 600s
(`src/infra/plugin-approvals.ts:50-51`). In principle a tool could call this mid-execute via
`callGatewayTool("plugin.approval.request", opts, {...})` and `await` the decision — but there is **no
`api.requestApproval(...)` convenience and no documented mid-execute usage**; the only documented/used
plugin pattern is the `before_tool_call` hook. (`src/agents/agent-tools.before-tool-call.ts:625,1046`
consumes `requireApproval`; the type alias is line 134.)

**`createOperatorApprovalsGatewayClient` / `withOperatorApprovalsGatewayClient` — wrong layer for us.**
`src/gateway/operator-approvals-client.ts`:
- `createOperatorApprovalsGatewayClient(params: Pick<GatewayClientOptions, "clientDisplayName"|"onClose"
  |"onConnectError"|"onEvent"|"onHelloOk"|"onReconnectPaused"> & { config: OpenClawConfig; gatewayUrl?:
  string }): Promise<GatewayClient>` (line 53-66).
- `withOperatorApprovalsGatewayClient<T>(params:{config: OpenClawConfig; gatewayUrl?; clientDisplayName},
  run:(client:GatewayClient)=>Promise<T>): Promise<T>` (line 103-110).
- Exported via `openclaw/plugin-sdk/gateway-runtime` (`src/plugin-sdk/gateway-runtime.ts:37-40`; export
  subpath present in 2026.6.1). These build a **backend Gateway client scoped to `operator.approvals`**
  to RECEIVE/RESOLVE approval events (the approver side, e.g. a channel that shows approve buttons), not
  the requester side. They need a full `OpenClawConfig` (available on tool ctx as `ctx.config`) and open
  a new WS connection — a CLI/service-level surface, not how a tool requests its own gate.

Gotcha: a tool cannot cleanly "pause" itself for approval after work has begun; design the gate as the
`before_tool_call` hook (or a first-step check inside `execute` that does a single blocking
`plugin.approval.request` RPC and aborts on `deny`). For our `workflow` tool, a `before_tool_call` hook
keyed on `toolName === "workflow"` + the destructive phase in `event.params` is the clean path.

### Plan #3 feasibility verdict

**Canvas (9.3) and Approval (9.5) are GREEN** — both have first-class plugin paths: A2UI via
`api.runtime.nodes.invoke({command:"canvas.a2ui.pushJSONL"})` (requires the canvas plugin + a paired
node), and approvals via the documented `before_tool_call` → `requireApproval` hook (true blocking gate
before the tool runs). **Detached execution (9.1) and Save-as-command (9.4) are PARTIAL/workaround** —
the raw detached task-ledger functions are core-internal and off-limits to a third-party plugin, but the
sanctioned equivalent (`api.runtime.tasks.managedFlows` for durable flow state + progress journal,
`api.session.workflow.scheduleSessionTurn` for the deferred wakeup, and an immediate
`details:{async:true}` tool return) delivers the same UX; commands can only be declared at load time, so
"save as command" must be a stored definition replayed through one fixed `workflow` tool param rather
than a dynamically-minted command. **KV persistence (9.2) is the one real blocker:** `openKeyedStore`
is hard-gated to `origin==="bundled" || trustedOfficialInstall===true` (`registry.ts:2625`) and WILL
throw for our externally-installed plugin in 2026.6.1 — so the resume journal must ride on managedFlow
`stateJson`/`waitJson` (not trust-gated) or a dedicated plugin-owned SQLite schema, never `openKeyedStore`
and never a JSON sidecar. Net: 2 GREEN, 2 GREEN-with-workaround, 1 needs-the-managedFlows-substitute.

## 10. Plan #3 managedFlows signatures (EXACT — pinned from real source + 2026.6.1 d.ts)

All signatures below were read from `~/projects/openclaw` source and re-confirmed byte-for-byte in
`node_modules/openclaw/dist/types-DOrS-soN.d.ts` (the package our build resolves). Source `file:line`
cited first; d.ts line second.

### 10.1 `api.runtime.tasks.managedFlows` shape

**Access path.** `api.runtime` is a `PluginRuntime` (`PluginRuntimeCore & {...}`); `PluginRuntimeCore`
carries `tasks: { runs, flows, managedFlows, flow }`. So `managedFlows` is reached as
`api.runtime.tasks.managedFlows` (d.ts:2680-2685, the `tasks: {...}` block inside `PluginRuntimeCore`).
`PluginRuntimeTasks` itself is assembled by `createRuntimeTasks({ legacyTaskFlow })` where both
`managedFlows` and `flow` alias the same `legacyTaskFlow` value (`runtime-tasks.ts:215-224`).

`managedFlows: PluginRuntimeTaskFlow` — **type marked `/** @deprecated Use runtime.tasks.flows for
DTO-based TaskFlow access. */`** but it is the ONLY surface exposing write/mutate (create/setWaiting/
resume/finish/fail). `runtime.tasks.flows` (`PluginRuntimeTaskFlows`) is read-only DTO access
(`get`/`list`/`findLatest`/`resolve`/`getTaskSummary`) — it has NO create or mutate. So for Plan #3
durable resume-journal state, `managedFlows` is mandatory despite the deprecation note.

**`PluginRuntimeTaskFlow`** (`runtime-taskflow.types.ts:141-149` / d.ts:1936-1942) — the entry seam:
```
type PluginRuntimeTaskFlow = {
  bindSession: (params: { sessionKey: string; requesterOrigin?: TaskDeliveryState["requesterOrigin"] }) => BoundTaskFlowRuntime;
  fromToolContext: (ctx: Pick<OpenClawPluginToolContext, "sessionKey" | "deliveryContext">) => BoundTaskFlowRuntime;
};
```
From inside a tool, call `api.runtime.tasks.managedFlows.fromToolContext(ctx)` (ctx = the
`OpenClawPluginToolContext`, needs `.sessionKey` + `.deliveryContext`) to get the session-bound runtime.
`bindSession({ sessionKey })` is the non-tool variant. Bound runtime asserts a non-empty sessionKey or
throws "TaskFlow runtime requires a bound sessionKey." (`runtime-tasks.ts:124-127`).

**Create a flow.** `BoundTaskFlowRuntime.createManaged` / `tryCreateManaged`
(`runtime-taskflow.types.ts:74-75` / d.ts:1867-1868):
```
createManaged:    (params: ManagedTaskFlowCreateParams) => ManagedTaskFlowRecord;        // throws on collision
tryCreateManaged: (params: ManagedTaskFlowCreateParams) => ManagedTaskFlowRecord | null; // null on collision
```
`ManagedTaskFlowCreateParams` (`runtime-taskflow.types.ts:36-48` / d.ts:1834-1846):
```
{ controllerId: string; goal: string; status?; notifyPolicy?: TaskNotifyPolicy;
  currentStep?: string | null; stateJson?: JsonValue | null; waitJson?: JsonValue | null;
  cancelRequestedAt?: number | null; createdAt?; updatedAt?; endedAt?: number | null }
```
`controllerId` is the plugin's stable id for the flow controller; `goal` is required free text.
`stateJson`/`waitJson` are the durable JSON slots (our resume journal lives here — `JsonValue` from
`task-flow-registry.types.ts:6-12`: null|bool|number|string|array|object).

**Owner/flowId model.** Returned `ManagedTaskFlowRecord = TaskFlowRecord & { syncMode:"managed"; controllerId:string }`
(`runtime-taskflow.types.ts:14-17`). `TaskFlowRecord` (`task-flow-registry.types.ts:61-80`) has:
`flowId` (host-assigned id), `ownerKey` (= the bound sessionKey — owner scoping is by sessionKey, NOT
by plugin), `controllerId?`, `revision: number` (optimistic-concurrency counter), `status: TaskFlowStatus`
("queued"|"running"|"waiting"|"blocked"|"succeeded"|"failed"|"cancelled"|"lost"), `goal`, `currentStep?`,
`stateJson?`, `waitJson?`, `blockedTaskId?`, `createdAt`/`updatedAt`/`endedAt?`. Every flow is keyed by
`flowId` and access is owner-scoped: all reads go through `*ForOwner(callerOwnerKey: sessionKey)`
(`runtime-tasks.ts:131-176`) — a plugin can only see flows owned by the session it bound to.

**Read by id / write stateJson.** Reads on the bound runtime return raw `TaskFlowRecord`:
`get(flowId)`, `list()`, `findLatest()`, `resolve(token)`, `getTaskSummary(flowId)`
(`runtime-taskflow.types.ts:76-80`). To **write `stateJson`** you must use a revision-checked mutator —
there is no bare setter. The mutators (`runtime-taskflow.types.ts:81-119` / d.ts:1874-1911) all take
`{ flowId, expectedRevision, ...slots, updatedAt? }` and return `ManagedTaskFlowMutationResult`:
```
setWaiting({ flowId, expectedRevision, currentStep?, stateJson?, waitJson?, blockedTaskId?, blockedSummary?, updatedAt? })
resume    ({ flowId, expectedRevision, status?: "queued"|"running", currentStep?, stateJson?, updatedAt? })
finish    ({ flowId, expectedRevision, stateJson?, updatedAt?, endedAt? })
fail      ({ flowId, expectedRevision, stateJson?, blockedTaskId?, blockedSummary?, updatedAt?, endedAt? })
requestCancel({ flowId, expectedRevision, cancelRequestedAt? })
cancel    ({ flowId, cfg: OpenClawConfig }) => Promise<BoundTaskFlowCancelResult>   // async; needs cfg
runTask   ({ flowId, runtime: TaskRuntime, task: string, ... }) => BoundTaskFlowTaskRunResult
```
`ManagedTaskFlowMutationResult` (`runtime-taskflow.types.ts:25-34` / d.ts:1826-1833) is a discriminated
union: `{ applied:true; flow:ManagedTaskFlowRecord }` OR `{ applied:false; code: ManagedTaskFlowMutationErrorCode; current?: TaskFlowRecord }`
where `code = "not_found"|"not_managed"|"revision_conflict"|"persist_failed"`. **Pattern for Plan #3
resume-journal write:** read flow → take `flow.revision` → call `setWaiting/resume` with
`expectedRevision = flow.revision` and the new `stateJson`; on `applied:false code:"revision_conflict"`,
re-read `current` and retry. This is the optimistic-concurrency write loop; there is no last-writer-wins
setter.

### 10.2 `api.session.workflow.scheduleSessionTurn` (the deferred wakeup)

`api.session.workflow` is `OpenClawPluginSessionWorkflowApi` (`types.ts:2528-2556`). Signature
(`types.ts:2549-2551` / d.ts:6777):
```
scheduleSessionTurn: (params: PluginSessionTurnScheduleParams) => Promise<PluginSessionSchedulerJobHandle | undefined>;
```
(Flat `api.scheduleSessionTurn` at `types.ts:2852` is the **@deprecated** alias; use the
`api.session.workflow.*` form.)

**Exact params** — `PluginSessionTurnScheduleParams` is a 3-arm union over a common base
(`host-hooks.ts:261-289` / d.ts:4517-4540):
```
common: { sessionKey: string; message: string; agentId?: string;
          deliveryMode?: "none" | "announce"; name?: string; tag?: string }
arm A:  { at: string|number|Date; deleteAfterRun?: boolean } & common
arm B:  { delayMs: number;        deleteAfterRun?: boolean } & common
arm C:  { cron: string; tz?: string; deleteAfterRun?: false } & common   // recurring cannot deleteAfterRun=true
```
`tag` is the cleanup key used by `unscheduleSessionTurnsByTag` (reserved cron delimiters like `:` are
rejected). For a one-shot resume wakeup use arm A (`at`) or arm B (`delayMs`) with `deleteAfterRun:true`.

**What a woken turn delivers.** `scheduleSessionTurn` does NOT run code — it hands timing to Cron. The
impl `schedulePluginSessionTurn` (`host-hook-scheduled-turns.ts:277-296`) creates a Cron job with
`payload: { kind: "agentTurn", message }`, `sessionTarget: \`session:${sessionKey}\``, `wakeMode: "now"`,
`delivery: { mode: deliveryMode ?? "announce" }`, and `deleteAfterRun: params.schedule.deleteAfterRun ?? (kind==="at")`.
So when the timer fires, Cron **submits `message` as a fresh agent turn in that session** (i.e. the agent
wakes and processes `message` as if it were an inbound prompt). `deliveryMode:"none"` runs the turn
silently (no channel announce); `"announce"` posts to the last channel. There is no callback/handler —
the resume signal IS the message text injected into the session turn. **HARD GATE:** the impl early-returns
`{ removed:0 }` / no-ops unless `params.origin === "bundled"` (`host-hook-scheduled-turns.ts:362`,
and the schedule path is bundled-only too) — same trust gate as `openKeyedStore`. For our externally
installed plugin in 2026.6.1 this will silently return `undefined`. Plan #3 must treat the handle as
best-effort and fall back to a managedFlow `waiting` status the agent polls, OR rely on the standard
"completion event wakes the requester" path rather than a self-scheduled turn.

**Return.** `PluginSessionSchedulerJobHandle` (`host-hooks.ts:213-218` / d.ts:4474-4479):
`{ id: string; pluginId: string; sessionKey: string; kind: string }` — or `undefined` when scheduling
was rejected/unavailable. Companion: `unscheduleSessionTurnsByTag(params: { sessionKey; tag }) =>
Promise<{ removed: number; failed: number }>` (`host-hooks.ts:291-299`, `types.ts:2553-2555`).

### 10.3 "Background started" tool-return convention

Confirmed canonical shape (`media-generate-background-shared.ts:328-355`,
`session-async-task-status.ts:65-79`, also `extensions/codex/.../dynamic-tool-execution.ts:228-234`):
a tool that kicks off async work returns
```
{ content: [{ type: "text", text: "Background task started ... do not call again; wait for completion." }],
  details: { async: true, status: "started", taskId, runId, task: { taskId, runId } } }
```
`details.async: true` + `details.status: "started"` is the discriminator the host uses to know the tool
deferred its real result; `taskId` (and `runId`) point the host/agent at the live task so completion can
be correlated and so a duplicate re-invocation can be short-circuited (the "existingTask" variant returns
`details: { async:true, active:true, existingTask:true, status, task:{taskId,runId} }`). For Plan #3 the
`workflow` tool returns exactly this with our managedFlow id surfaced as `taskId` (and the bound task's
`runId` if a `runTask` child exists).

### 10.4 `before_tool_call` hook arg/return type names + `api.on`

Hook is in `PluginHookHandlerMap` (`hook-types.ts:1086-1089`):
```
before_tool_call: (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext)
  => Promise<PluginHookBeforeToolCallResult | void> | PluginHookBeforeToolCallResult | void;
```
- **Event** `PluginHookBeforeToolCallEvent` (`hook-types.ts:518-539`):
  `{ toolName: string; params: Record<string,unknown>; toolKind?; toolInputKind?; runId?; toolCallId?; derivedPaths?: readonly string[] }`.
- **Context** `PluginHookToolContext` (`hook-types.ts:502-516`):
  `{ agentId?; sessionKey?; sessionId?; runId?; trace?; toolName; toolKind?; toolInputKind?; toolCallId?; getSessionExtension?; channelId? }`.
- **Result** `PluginHookBeforeToolCallResult` (`hook-types.ts:552-566`):
  `{ params?: Record<string,unknown>; block?: boolean; blockReason?: string; requireApproval?: { title; description; severity?; timeoutMs?; timeoutBehavior?: "allow"|"deny"; allowedDecisions?: Array<"allow-once"|"allow-always"|"deny">; pluginId?; onResolution?: (decision: PluginApprovalResolution) => Promise<void>|void } }`.
  `PluginApprovalResolution = "allow-once"|"allow-always"|"deny"|"timeout"|"cancelled"`
  (`PluginApprovalResolutions` const, `hook-types.ts:541-550`). Returning `requireApproval` is the true
  blocking gate; returning `block:true` hard-rejects. For Plan #3 approval, key on
  `event.toolName === "workflow"` + the destructive phase encoded in `event.params`.

- **`api.on` IS on the plugin register API.** `OpenClawPluginApi.on` (`types.ts:2908-2912` / d.ts:7039):
  ```
  on: <K extends PluginHookName>(hookName: K, handler: PluginHookHandlerMap[K],
       opts?: { priority?: number; timeoutMs?: number }) => void;
  ```
  Generic over `PluginHookName` so the handler is type-checked against `PluginHookHandlerMap[K]`.
  `"before_tool_call"` is a valid `PluginHookName` (`hook-types.ts:89`, in `PLUGIN_HOOK_NAMES` at :136).
  (`api.registerHook(events, handler, opts)` at `types.ts:2630-2634` is the untyped multi-event variant;
  prefer `api.on` for a single typed hook.)

### 10.5 `api.runtime.nodes.invoke` + resolving a paired Canvas nodeId

**Signature.** `api.runtime.nodes` (`types.ts:90-93` / d.ts:4861-4864):
```
nodes: {
  list:   (params?: RuntimeNodeListParams) => Promise<RuntimeNodeListResult>;
  invoke: (params: RuntimeNodeInvokeParams) => Promise<unknown>;
};
```
`RuntimeNodeInvokeParams` (`types.ts:70-76` / d.ts:4845-4851):
```
{ nodeId: string; command: string; params?: unknown; timeoutMs?: number; idempotencyKey?: string }
```
Returns `Promise<unknown>` — the raw transport envelope; callers must unwrap (real-world canvas/browser
results come back as `{ payloadJSON }` or `{ payload }` needing a parse — see unwrap pattern below).

**Resolving a paired node** — canonical pattern from `extensions/google-meet/src/transports/chrome-browser-proxy.ts:84-148`
(applies 1:1 to Canvas; swap the cap/command names):
1. `runtime.nodes.list({ connected: true })` → `RuntimeNodeListResult` =
   `{ nodes: Array<{ nodeId; displayName?; remoteIp?; connected?; caps?: string[]; commands?: string[] }> }`
   (`types.ts:55-68`).
2. Filter for the capability: a node is usable when `node.connected === true` AND its `commands`/`caps`
   advertise the feature. google-meet checks `commands.includes("googlemeet.chrome") && (commands.includes("browser.proxy") || caps.includes("browser"))`
   (`chrome-browser-proxy.ts:49-57`). **For Canvas, filter on the canvas command/cap the canvas plugin
   advertises** (e.g. a `canvas.*` command / `browser` or `canvas` cap — confirm against the installed
   canvas node's advertised `commands` at runtime via `nodes.list`, do not hardcode).
3. Disambiguate: 0 matches → throw "no connected canvas node, run `openclaw node run` + approve pairing";
   exactly 1 → use its `nodeId`; >1 → require an explicit configured node id (match by
   `nodeId | displayName | remoteIp`, `chrome-browser-proxy.ts:59-61`).
4. `runtime.nodes.invoke({ nodeId, command: "<canvas command>", params: {...}, timeoutMs })`
   (`chrome-browser-proxy.ts:185-196`), then unwrap `payloadJSON`/`payload` from the `unknown` result
   (`chrome-browser-proxy.ts:150-165`).

There is no dedicated "get my paired node" helper — pairing is discovered by listing connected nodes and
matching advertised caps/commands, exactly as §9.3 (canvas A2UI) assumed.

## 11. Sub-agent config + save persistence (read-only verify vs openclaw HEAD d4b4a65 + installed 2026.6.1 d.ts)

Verifies what each `agent()` call can set on a spawned sub-agent (model / persona / tools), how to
confirm the model actually used, and whether saved workflows survive a gateway restart. Source read at
`~/projects/openclaw` (HEAD d4b4a65, package version 2026.6.2). Each param/type re-confirmed
byte-for-byte against the installed `node_modules/openclaw` 2026.6.1 d.ts. Source `file:line` cited
first; d.ts second.

### 11.1 Full `api.runtime.subagent.run` param set — exactly 9 fields, NO tools param

`SubagentRunParams` — `src/plugins/runtime/types.ts:9-19`; identical in installed d.ts
`node_modules/openclaw/dist/runtime-api-Cd4aqekH.d.ts:4795-4805`:

```ts
export type SubagentRunParams = {
  sessionKey: string;
  message: string;
  provider?: string;
  model?: string;
  extraSystemPrompt?: string;
  lane?: string;
  lightContext?: boolean;
  deliver?: boolean;
  idempotencyKey?: string;
};
```

Method type: `subagent.run: (params: SubagentRunParams) => Promise<SubagentRunResult>` where
`SubagentRunResult = { runId: string }` (`types.ts:21-23`, `:81`). The full surface is
`run | waitForRun | getSessionMessages | getSession (deprecated) | deleteSession` (`types.ts:80-89`).

The real `run` impl (gateway side) is `createGatewaySubagentRuntime().run` in
`src/gateway/server-plugins.ts:469-522`. It forwards to the gateway `"agent"` method passing ONLY:
`sessionKey, message, deliver, [provider], [model], extraSystemPrompt, lane,
bootstrapContextMode("lightweight" from lightContext===true), idempotencyKey` (server-plugins.ts:494-510).
The gateway `agent` schema is `AgentParamsSchema` (`packages/gateway-protocol/src/schema/agent.ts:176-229`)
with `additionalProperties: false` — and it has NO `tools`/`allowedTools`/`disallowedTools`/`toolPolicy`
field anywhere. So there is no path to pass a tool allow/deny list through `subagent.run`.

**Verdict: GREEN for the 9 listed params (no hidden extras). NOT-POSSIBLE for any per-call tools param.**
Our `agent()` maps to: `sessionKey` = per-agent child key, `message` = the task prompt, `model`/`provider`
= per-agent model override (gated, §11.3), `extraSystemPrompt` = per-agent persona (§11.2), `lane` =
optional queue lane, `lightContext` = cheap-context toggle, `deliver: false` (default — keep child output
internal), `idempotencyKey` = stable per-step key for retry-safety (the runtime auto-fills a UUID if
omitted, server-plugins.ts:509).

### 11.2 Persona / system prompt — `extraSystemPrompt` (GREEN, additive)

`extraSystemPrompt` is the param. It is forwarded verbatim to the gateway `agent` method
(`server-plugins.ts:502`) and accepted by `AgentParamsSchema.extraSystemPrompt` (`agent.ts:207`,
`Type.Optional(Type.String())`). It is ADDITIVE: it is injected alongside the child agent's normal
system prompt (the agent's configured base persona + bootstrap context), not a replacement — the child
still builds its default system prompt and `extraSystemPrompt` is appended as extra instruction text
(`src/agents/system-prompt.ts` composes the base; the gateway passes `extraSystemPrompt` through as an
additional block). There is no "replace the whole system prompt" param.

**Verdict: GREEN.** Our `agent({ persona })` sets `extraSystemPrompt: persona`. It layers on top of the
agent's base prompt; it cannot blank out the default. If a workflow needs a fully isolated persona, point
the child at a different `agentId`-scoped session — but note `subagent.run` has no `agentId` param, so the
child always runs as the current agent identity with the persona appended.

### 11.3 Model override gate — `plugins.entries.<id>.subagent.allowModelOverride` (GATED)

Exact config path: `plugins.entries.<pluginId>.subagent.allowModelOverride: boolean` (+ optional
`plugins.entries.<pluginId>.subagent.allowedModels: string[]`, where `"*"` = allow any).
Type: `src/config/types.plugins.ts:19-27`. Zod: `src/config/zod-schema.ts:289-292`. The exact same key is
used in production by memory-core (`extensions/memory-core/openclaw.plugin.json:27`), confirming the
contract for a third-party plugin like workflows.

Enforcement (the code that rejects model without the gate) is `createGatewaySubagentRuntime().run`:
- `overrideRequested = Boolean(params.provider || params.model)` (server-plugins.ts:475).
- For a plugin-runtime spawn (no request-scope client), it calls `authorizeFallbackModelOverride(...)`
  (server-plugins.ts:174-224). If `policy?.allowModelOverride` is not `true` it THROWS:
  `plugin "<id>" is not trusted for fallback provider/model override requests...` (server-plugins.ts:188-195).
- If allowed but an `allowedModels` allowlist is set, the requested `provider/model` must be in it or it
  throws `model override "<ref>" is not allowlisted...` (server-plugins.ts:217-223).
- Crucially, when override is NOT allowed the spawn does NOT silently ignore the model — it REJECTS
  (throws). And `model`/`provider` are only forwarded `...(allowOverride && params.model && {...})`
  (server-plugins.ts:500-501), so without the gate they are stripped AND the call throws.
- Policies are loaded from config by `setPluginSubagentOverridePolicies(cfg)` (server-plugins.ts:135-172),
  process-global, refreshed on config load.

**With the key true (or `allowedModels` matching):** `model`/`provider` pass through to the child run.
**Without it:** any `subagent.run` that sets `model`/`provider` THROWS; a call with neither runs fine on
the agent default model.

**Verdict: GATED.** Our `agent({ model })` requires the operator to set
`plugins.entries.workflows.subagent.allowModelOverride: true` (or an `allowedModels` allowlist). We should
(a) document this as a setup prerequisite, (b) catch the thrown error and surface a clear "enable
allowModelOverride" message rather than letting the workflow crash, and (c) when `model` is unset, omit it
entirely so ungated installs still run on the default model.

### 11.4 Per-call TOOLS restriction — NOT-POSSIBLE per call; CONFIG-ONLY scoping

There is NO per-call tools param (see §11.1 — `AgentParamsSchema` is `additionalProperties:false` with no
tools field). A single `subagent.run` cannot hand the child an allow/deny tool list.

How sub-agent tools ARE scoped (config-only, per-agent, not per-spawn):
- `tools.subagents.tools: { allow?: string[]; alsoAllow?: string[]; deny?: string[] }` —
  `src/config/types.tools.ts:732-739` ("Sub-agent tool policy defaults (deny wins)").
- Enforced by `resolveSubagentToolPolicy(cfg, depth)` (`src/agents/agent-tools.policy.ts:106-123`) and
  `resolveSubagentToolPolicyForSession(...)` (`:126-...`). It also applies depth-based default denies
  (deeper children lose `subagents`/`sessions_spawn`, agent-tools.policy.ts:67-118) governed by
  `agents.defaults.subagents.maxSpawnDepth`. Deny always wins over allow.

This policy is resolved from config at spawn time keyed on the agent/session — it is the SAME for every
child the agent spawns. There is no documented per-`subagent.run` mechanism to vary it call-by-call.

**Verdict: NOT-POSSIBLE per-call. CONFIG-ONLY via `tools.subagents.tools` (allow/alsoAllow/deny, deny
wins) plus depth-based defaults.** Our `agent({ tools })` cannot be honored per call through the SDK.
Realistic workarounds: (1) set a single workflow-wide `tools.subagents.tools` policy in config and
document it; (2) if a workflow genuinely needs different toolsets per agent step, that is outside the
injected `subagent.run` contract — it would require a per-agent-identity session with its own `tools`
config, which `subagent.run` (no `agentId` param) cannot select. Treat per-agent tools as a non-goal for
v1 and expose only the config-level knob.

### 11.5 Verifying the model actually used (live test)

The `run` result is only `{ runId }` and `waitForRun` is only `{ status, error? }`
(`types.ts:21-33`) — neither echoes the model. The injected `getSessionMessages` returns only
`{ messages }`: the `sessions.get` handler responds `{ messages }` with no session-level model field
(`src/gateway/server-methods/sessions.ts:2491-2535`). So the runtime surface we hold does NOT directly
return the per-child model.

The canonical per-child model IS persisted and observable elsewhere:
- The child's session row stores `model` + `modelProvider`; the gateway broadcasts them on the
  `session.update` event (`src/gateway/server-methods/agent.ts:609-610`) and they are returned by the
  `sessions.list` gateway method (schema model field `packages/gateway-protocol/src/schema/sessions.ts:231`).
- The embedded agent runner logs the resolved model per run:
  `provider=${provider}/${modelId} harness=...` (`src/agents/embedded-agent-runner/run.ts:3175`).

**Most reliable signal for a live test: the gateway log line `provider=<provider>/<model>` emitted by the
embedded agent runner for the child run** (run.ts:3175) — it shows the actually-resolved model after all
gating/fallback, not just what we requested. Secondary programmatic signal: query the child session's
`model`/`modelProvider` via the gateway `sessions.list` method (or observe the `session.update` event),
which reflects the model the row was created/updated with. The injected `subagent` runtime alone is
insufficient — confirm via gateway logs or a `sessions.list` call.

**Verdict: GATED/indirect.** No per-call return value exposes the model; use the gateway runner log
(`run.ts:3175`) as primary proof and `sessions.list` session metadata as the programmatic check.

### 11.6 Save persistence across restart — durable SQLite, SURVIVES restart (GREEN)

`api.runtime.tasks.managedFlows` `stateJson` (§10) is backed by the `flow_runs` table in the SHARED state
SQLite DB on disk — durable across process restart.

- Backing store: `src/tasks/task-flow-registry.store.sqlite.ts` — uses `node:sqlite` `DatabaseSync`
  (line 2), writes via `insertInto("flow_runs")` with `state_json` column (lines 113, 161, 177-192).
- Table DDL: `src/state/openclaw-state-schema.sql:1139-1163` — `CREATE TABLE IF NOT EXISTS flow_runs (...
  owner_key TEXT NOT NULL, status TEXT NOT NULL, goal TEXT NOT NULL, state_json TEXT, wait_json TEXT,
  revision, created_at, updated_at, ended_at ...)` with indexes on status/owner_key/updated_at. This is
  the shared state schema (same file that defines core runtime tables).
- File location: the shared state DB at `state/openclaw.sqlite`
  (`src/state/openclaw-state-db.paths.ts:38-40` → `resolveOpenClawStateSqlitePath` →
  `<stateRoot>/state/openclaw.sqlite`; confirmed by `src/state/openclaw-state-db.test.ts:41,65`). It is a
  real file path, not `:memory:`.
- The runtime taskflow accessors (`createManaged`/`get`/`list`/`findLatest`/`resolve`/`setWaiting`/
  `resume`/`finish`, `src/plugins/runtime/runtime-taskflow.ts:124-...`) all delegate to these
  SQLite-backed registry functions; reads use `getTaskFlowByIdForOwner` / `listTaskFlowsForOwner` keyed on
  `owner_key`, so a flow saved before restart is found by `owner_key` after restart.

**Verdict: GREEN.** save → restart gateway → run-saved finds it: the managed flow row (including
`state_json`) is committed to the on-disk shared `state/openclaw.sqlite` `flow_runs` table and is read back
by owner key after a fresh process start. Per OpenClaw storage policy (SQLite-only, no JSON sidecars) this
is the canonical durable store. Our save action persists via `managedFlows.createManaged(... stateJson)`;
run-saved re-resolves via `managedFlows.list()/get()/resolve()` keyed on the same owner session key.

### 11.7 One-paragraph feasibility verdict

**Per-agent model: GATED** — set via `subagent.run({ model, provider })` but ONLY if the operator enables
`plugins.entries.workflows.subagent.allowModelOverride: true` (optionally constrained by `allowedModels`);
without it the spawn throws, so `agent()` must omit `model` when unset and surface a clear setup error.
**Per-agent persona: GREEN** — `subagent.run({ extraSystemPrompt })` injects a custom system-prompt block,
additive on top of the agent's base prompt (cannot replace it). **Per-agent tools: NOT-POSSIBLE per call**
— no per-spawn tools param exists; tools are CONFIG-ONLY via `tools.subagents.tools` (allow/alsoAllow/deny,
deny wins) plus depth defaults, identical for every child, so treat per-agent tools as a non-goal and
expose only the global config knob. **Model-used verification: indirect** — no API return echoes the
model; rely on the gateway runner log `provider=<provider>/<model>` (run.ts:3175) and/or the child
session's `model`/`modelProvider` via `sessions.list`/`session.update`. **Save-survives-restart: GREEN** —
`managedFlows` `stateJson` is committed to the durable on-disk `flow_runs` table in `state/openclaw.sqlite`
and is re-read by owner key after a gateway restart.

## 12. Spawning into a pre-configured agent

Verified read-only against source clone `~/projects/openclaw` HEAD `d4b4a65` and the installed
`openclaw@2026.6.1` d.ts in `node_modules/openclaw`. HYPOTHESIS under test: instead of per-call model/tools
overrides (which don't exist), define a SEPARATE OpenClaw agent (e.g. `auditor`) with its own model + tool
allow/deny + persona, then spawn the workflow child to run AS that agent so it inherits that config.

### 12.1 Targeting a different agent on spawn — verdict per sub-question

(a) **sessionKey prefix routes config resolution to `<agentId>` — GREEN.** A child started on session key
`agent:auditor:subagent:<uuid>` resolves its entire run config as agent `auditor`. The agentId is parsed
from the key: `parseAgentSessionKey` splits `agent:<id>:<rest>` and returns `agentId = parts[1]`
(`src/sessions/session-key-utils.ts:232-252`). The run pipeline derives `sessionAgentId` from the key via
`resolveSessionAgentId` → `resolveSessionAgentIds` (`src/agents/agent-scope.ts:319-325`, parse at
`:313-315`), used in `src/agents/agent-command.ts:692-697`, then threaded into workspace, agentDir, model,
tools, prompt, skills (`agent-command.ts:705,709,1100,1109,1190-1192,1248,1420,1525,...`).

(b) **No `agentId` param on the PLUGIN runtime `subagent.run` — CONFIG/NO.** The plugin-facing API
`api.runtime.subagent.run` takes `SubagentRunParams = { sessionKey, message, provider?, model?,
extraSystemPrompt?, lane?, lightContext?, deliver?, idempotencyKey? }` — NO `agentId`, NO `tools`
(installed `node_modules/openclaw/dist/types-DOrS-soN.d.ts:4795-4805`; impl
`src/gateway/server-plugins.ts:468-522`, which only forwards `sessionKey` to the gateway `agent` method).
So at the plugin layer the ONLY lever to pick the target agent is the `agent:<agentId>:...` prefix of
`sessionKey`. The separate `agentId` param the user saw lives on the BUILT-IN model-facing tool
`sessions_spawn` (`src/agents/tools/sessions-spawn-tool.ts:179,313,472-484` → `spawnSubagentDirect`), which
the model invokes — it is not reachable from `api.runtime.subagent.run`.

CONCLUSION (item 1): the workflow plugin selects the target agent by constructing the child session key as
`agent:<targetAgentId>:subagent:<uuid>` (this is exactly the format `spawnSubagentDirect` itself emits —
`src/agents/subagent-spawn.ts:1219`). Passing `sessionKey: "agent:auditor:subagent:<uuid>"` to
`subagent.run` makes the child resolve all config as `auditor`.

### 12.2 Per-agent config schema (model + tools + persona) — CONFIG

Multiple agents are defined as a LIST under `agents.list[]` (NOT an `agents.<id>` map). Schema
`AgentConfig` at `src/config/types.agents.ts:80-158`; container `AgentsConfig = { defaults?, list? }` at
`:160-163`. Per-agent fields relevant here:

- **MODEL** — `AgentConfig.model?: AgentModelConfig` (`types.agents.ts:88`). `AgentModelConfig` =
  `string | { primary?: string; fallbacks?: string[] }` (`src/config/types.agents-shared.ts:10-17`). Also
  per-agent SUBAGENT model: `AgentConfig.subagents.model?` (`types.agents.ts:137-138`).
- **TOOLS (allow/deny)** — `AgentConfig.tools?: AgentToolsConfig` (`types.agents.ts:155`). `AgentToolsConfig`
  = `{ profile?, allow?, alsoAllow?, deny?, byProvider?, toolsBySender?, codeMode?, elevated?, exec?, fs?,
  loopDetection?, message?, sandbox? }` (`src/config/types.tools.ts:398-434`). This is the real per-agent
  allow/deny knob (deny wins, profile then allow/alsoAllow/deny).
- **PERSONA** — NUANCE. `AgentConfig.identity?: IdentityConfig` exists (`types.agents.ts:130`) but
  `IdentityConfig` is only `{ name?, theme?, emoji?, avatar? }` (`src/config/types.base.ts:383-389`) — it is
  display identity, NOT a system-prompt/instructions field. There is NO per-agent `systemPrompt`/persona
  TEXT field on `AgentConfig` (the only `systemPrompt` keys are: ACP-harness CLI flags
  `systemPromptArg/...` at `types.agent-defaults.ts:164-174`, and a memory-flush-turn `systemPrompt` at
  `:589` — neither is an agent persona). An agent's persona/instructions instead come from its WORKSPACE
  bootstrap files (AGENTS.md/CLAUDE.md/identity) under that agent's `workspace`/`agentDir`
  (`AgentConfig.workspace`/`agentDir` at `types.agents.ts:86-87`; resolved per run at
  `agent-command.ts:705,709`). So per-agent persona = give the agent its own workspace dir with its own
  bootstrap files. (`subagent.run({ extraSystemPrompt })` can ADD a block on top, but cannot replace the
  base persona — see §11.7.)

### 12.3 Does the child actually USE that agent's config? — GREEN

When the child runs on `agent:auditor:subagent:x`, every resolver is keyed on the parsed `auditor`:

- **Model** — `resolveSubagentSpawnModelSelection({ agentId: targetAgentId })` reads
  `resolveAgentConfig(cfg, agentId)?.subagents?.model ?? agents.defaults.subagents.model ??
  agentConfig?.model` (`src/agents/model-selection.ts:326-337,359-385`; target chosen in
  `subagent-spawn.ts:1169,1266-1274` via `subagent-spawn-plan.ts:50-63`). At run time the model is again
  resolved for `sessionAgentId` (`agent-command.ts:1190-1192`).
- **Tools (allow/deny)** — `resolveEffectiveToolPolicy` derives agentId from the sessionKey
  (`resolveAgentIdFromSessionKey`) → `resolveAgentConfig(config, agentId)` → `agentTools = agentConfig.tools`
  and layers its profile/allow/alsoAllow/deny/byProvider over global
  (`src/agents/agent-tools.policy.ts:450-535`, agentId at `:461-466`). So the child gets the TARGET agent's
  tool policy, not main's.
- **Persona/workspace** — `resolveAgentWorkspaceDir(cfg, sessionAgentId)` and `resolveAgentDir(cfg,
  sessionAgentId)` (`agent-command.ts:705,709`) load the target agent's workspace bootstrap. The subagent
  preamble (`src/agents/subagent-system-prompt.ts:10-128`) is layered ON TOP of that base persona.

### 12.4 Cross-agent spawn permission — CONFIG (gate exists)

`main` spawning a child as `auditor` is GATED by an allowlist. Default policy: a requester may only spawn
its OWN agent id; targeting a DIFFERENT agent requires `subagents.allowAgents` to permit it. Gate:
`resolveSubagentTargetPolicy` (`src/agents/subagent-target-policy.ts:84-120`): returns ok only if
`requestedAgentId` is empty and target==requester, OR target is in the resolved allowlist. Allowlist source:
`resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ?? cfg.agents.defaults.subagents.allowAgents`
(`subagent-spawn.ts:1204-1212`). `allowAgents` is `string[]`, supports `"*"` (any configured agent) and is
intersected with the configured agent registry (`subagent-target-policy.ts:51-82`). Schema:
`AgentConfig.subagents.allowAgents?: string[]` (`types.agents.ts:135-136`). NOTE this gate lives in
`spawnSubagentDirect` (the built-in tool path). The PLUGIN `subagent.run` path does NOT call
`spawnSubagentDirect` — it forwards `sessionKey` straight to the gateway `agent` method
(`server-plugins.ts:494-516`), so the plugin can construct any `agent:<id>:...` key directly. The cross-agent
allowlist therefore constrains the MODEL-driven `sessions_spawn` tool; the native plugin runtime is trusted
in-process (`PluginRuntime` is the "trusted in-process runtime surface",
`types-DOrS-soN.d.ts:4852`) and is not re-gated by `allowAgents`. The hard requirement is that `auditor`
must be a CONFIGURED agent (present in `agents.list[]`) so its config resolves; an unknown id falls back to
default-agent resolution and `isValidAgentId` formatting only.

### 12.5 Live verification signal — how to confirm the child ran as `auditor`

1. **Session identity** — `sessions.list` / subagent-list item exposes both `agentId` (parsed from the
   child session key, `src/agents/subagent-list.ts:70`) and the resolved `model` (`:50`). Assert the child
   row shows `agentId="auditor"` and auditor's model.
2. **Gateway runner log** — the embedded runner logs `provider=${provider}/${modelId}` per turn
   (`src/agents/embedded-agent-runner/run.ts:3175`, also 1448/1773). A distinct auditor model shows up here.
3. **Behavioral check (strongest)** — give `auditor` a tool DENY (e.g. `agents.list[auditor].tools.deny:
   ["exec"]`) that `main` lacks; spawn the child as auditor and have it attempt that tool. It must be
   refused, proving the auditor tool policy (not main's) is in force. Equivalently, give auditor a distinct
   `model` and confirm via signals 1/2.

### 12.6 One-paragraph feasibility verdict

**Can per-helper tools+model+persona be achieved by spawning into a pre-configured agent? YES** (with one
caveat on persona). EXACT RECIPE:

1. **Define the agent in config** (`openclaw.json`), as a new entry in `agents.list[]`:
   `{ "id": "auditor", "model": "anthropic/claude-opus-4-8", "workspace": "<dir with auditor's
   AGENTS.md/CLAUDE.md persona>", "tools": { "profile": "...", "allow": [...], "deny": [...] } }`. Model →
   `model`; tools allow/deny → `tools.allow`/`tools.deny`; persona → the agent's own `workspace`/`agentDir`
   bootstrap files (NOT a config string — `identity` is display-only). Optionally set
   `subagents.model` for the model used when auditor itself spawns children.
2. **Target it from our `agent()` helper**: build the child session key as
   `agent:auditor:subagent:${crypto.randomUUID()}` and call
   `api.runtime.subagent.run({ sessionKey, message, ... })`. Do NOT pass `model`/`provider`/`tools` per call
   — the agent config supplies them. (`extraSystemPrompt` may still add a per-run block on top of auditor's
   persona.)
3. **Allowlist**: NOT required for the plugin runtime path (`subagent.run` bypasses the `allowAgents` gate;
   that gate only constrains the model-facing `sessions_spawn` tool). The only requirement is that `auditor`
   exists in `agents.list[]`. (If we ever route through the `sessions_spawn` tool / `spawnSubagentDirect`
   instead, then `main`'s `subagents.allowAgents` must include `"auditor"` or `"*"`.)
4. **Live-verify**: `sessions.list` shows the child with `agentId="auditor"` + auditor's `model`; gateway log
   shows `provider=<auditor model>`; and a tool auditor denies-but-main-allows is refused in the child.

CAVEAT (persona): per-agent persona is achievable but NOT via a config string — it requires giving the
agent its own workspace/bootstrap files. If the desired "persona" is just an extra instruction block,
`subagent.run({ extraSystemPrompt })` is simpler and needs no separate agent. Use the separate-agent
approach when you specifically need per-helper TOOL POLICY and/or per-helper MODEL isolation, which the
per-call API cannot give (no per-call tools param; per-call model is auth-gated per §11.7).

## 13. In-gateway spawn blocker (CRITICAL — found by the real install test)

Installing the plugin into a real isolated 2026.6.1 gateway and driving the `workflow`
tool via the main agent revealed that `agent()` spawns FAIL in-gateway:
`api.runtime.subagent.run(...)` throws **"Plugin runtime subagent methods are only
available during a gateway request."** (`src/plugin-sdk/error-runtime.ts`).

Root cause: the subagent runtime is bound to a per-request **AsyncLocalStorage** scope
(`src/plugins/runtime/gateway-request-scope.ts`), but our orchestration script runs in a
`node:vm` sandbox + a deferred concurrency scheduler. That request scope is not present
where our deferred/sandboxed spawns execute — it throws even for a single synchronous
`agent()` with no journal, and `AsyncResource.bind` at execute time did not restore it
(the scope is not active at the tool's execute boundary either).

Why the 6 out-of-process "live" tests passed anyway: they drive a `SubagentRuntime`
ADAPTER built on `callGatewayFromCli` ("agent"/"agent.wait"/"chat.history" RPCs over a
GatewayClient), which does NOT need the request ALS scope. That proved the engine + spine
LOGIC end-to-end, but masked this real in-gateway integration gap.

FIX DIRECTION (next work): inside `workflow-tool.ts`, replace `ctx.api.runtime.subagent`
with a self-connecting `GatewayClient` (loopback url + gateway token) using the SAME
agent/agent.wait/chat.history mechanism the live tests proved. This sidesteps the
request-scope requirement. (The detached/managedFlows path is blocked by the same issue —
its background child spawn never runs.)

Confirmed working in-gateway: plugin loads, the main agent calls the `workflow` tool, the
tool executes; only the sub-agent spawn (via api.runtime.subagent) is blocked. Headless
escape hatches added: OPENCLAW_WORKFLOWS_SKIP_APPROVAL=1 (skip the approval hook),
OPENCLAW_WORKFLOWS_INLINE=1 (force inline over detached). Per-agent routing via
`agent(prompt,{agent})` (sessionKey prefix, §12) is wired but untested in-gateway pending
this fix.

### §13 — RESOLVED (2026-06-07)

FIXED as planned: `src/skeleton/gateway-subagent.ts` exposes `createGatewaySubagent({url, token})`
(a `SubagentRuntime` over `callGatewayFromCli` agent/agent.wait/chat.history). `workflow-tool.ts`
now builds it from `ctx.api.config.gateway` (loopback `ws://127.0.0.1:<port>` + `auth.token`) and
passes it to `runWorkflow` instead of `api.runtime.subagent`. VERIFIED IN-GATEWAY: the installed
plugin's `workflow` tool spawns a real sub-agent and returns `PONG` (gateway log: "The workflow
returned **PONG** … successfully spawned a sub-agent"). Unit suite 45 green, build clean. The
self-connecting CLI client is not request-ALS-scoped, so it survives the vm/scheduler deferral.

### §14 — #4 in-gateway verification results (2026-06-07)

After §13 unblocked spawning, drove the isolated dev gateway (port 18790, real
moonshot/kimi reasoning agent) to verify the four "built-but-unverified" surfaces.
Evidence is the gateway log + the durable `flow_runs` SQLite rows (state DB
`state/openclaw.sqlite`), not the driver return (the dev driver gives up at 10s; the
gateway/flow completes regardless).

VERIFIED:
- §13 in-gateway spawn — workflow tool spawns a real sub-agent, returns PONG.
- #4c detached background run — with OPENCLAW_WORKFLOWS_INLINE unset, the tool returns
  immediately `{async:true, status:"started", flowId}` ("Workflow started in the
  background … wait for the completion turn"). The background engine then COMPLETED and
  PERSISTED: flow_runs row status=`succeeded`, state_json=`{"status":"done","result":"PONGDETACHED"}`.
- #4b save → restart → run-saved — `save` writes the script to a managed flow; after a
  full gateway process restart, `run-saved` loads + runs it and returns 42424.

BUG FOUND + FIXED during #4b (commit 359ebe5): the saved-store bound to `baseSessionKey`,
which embeds `ctx.toolCallId` (unique per call). So `save` (owner …subagent:wf-workflow:14)
and a later `run-saved` (owner …wf-workflow:18) used different owner_keys → "saved workflow
not found", even before any restart. Fix: bind the saved-store to a fixed
`SAVED_OWNER_KEY = "agent:main:workflows-saved"`. SQLite confirms the new durable row lives
under that stable owner_key (vs the old broken per-call row).

KNOWN GAPS (honest):
- Detached completion DELIVERY is incomplete (matches the "detached path is WIP" comment).
  The background run finishes + persists, but the "workflow finished" wakeup turn targets
  `baseSessionKey` (a synthetic `agent:main:subagent:wf-<toolCallId>` session), NOT the
  originating user conversation — because `ToolPluginExecutionContext` exposes only
  {api, signal, toolCallId, onUpdate}, with NO originating session key. No cron_jobs /
  delivery_queue_entries row was produced for the wakeup. So a real user would not be
  notified on completion. Needs either an SDK seam exposing the caller session, or delivery
  via the gateway's own run-completion path rather than a self-scheduled turn.
- #4a per-helper model via a named agent (`agent(prompt,{agent:"auditor"})`) — the sessionKey
  routing code is in place, but the `auditor` agent returns null in the minimal dev gateway
  (the named agent needs full provisioning / workspace to actually run). Routing is wired,
  not live-proven.
- Canvas surface (needs a paired UI node) and the before_tool_call approval hook (needs a
  human approver; only the SKIP env was exercised) are headless-blocked — not verifiable in
  this setup.

### §15 — "execute the rest" round: #4a, #2, and detached completion (2026-06-07)

Drove the isolated dev gateway (port 18790) to finish the remaining items. Backed by a
parallel source-research workflow (3 agents over the cloned openclaw + dist).

#4a — per-helper model via a named agent — RESOLVED + VERIFIED.
Root cause of the earlier NULL (R2, high-confidence with citations): a named agent runs
with its OWN agentDir (`<state>/agents/<id>/agent/`) and its own EMPTY auth store; with no
moonshot credential there and no MOONSHOT_API_KEY/KIMI_API_KEY in env, the child throws
`missing-provider-auth` AFTER the `agent` RPC already returned its ack — the spawner reads
only runId, so it surfaces as NULL, not an error. Model routing itself is fine (per-agent
`agents.list[].model` is honored). Fix: put MOONSHOT_API_KEY in the gateway env (env-backed
auth discovery covers any agent). VERIFIED: `agent({agent:"auditor"})` now runs; the auditor
session trajectory records `"model":"moonshot/kimi-k2.5"` (vs main = kimi-k2.6) — genuine
per-helper model swap, empirically proven.

#2 — a real agent authoring its own orchestration script (the "dynamic" part) — VERIFIED,
with a fix. Never tested before. Drove kimi-k2.6 to author a workflow with NO script given.
First attempt died: the agent naturally wrote `parallel(t1, t2)` (varargs) but the API only
accepted `parallel([t1, t2])` → opaque "thunks.map is not a function". Fixed: parallel()
now accepts varargs OR an array and throws an actionable error on a non-function; the tool's
`script` param documents every primitive's signature. After the fix the agent authored a
working script first-try and the workflow returned {"france":"Paris","japan":"Tokyo"}.

A — detached completion — IMPLEMENTED via PULL (push is not available to us).
Research finding (R1, high-confidence): the "gateway completion callback" that would push a
detached result to the originating user session does NOT exist for an externally-installed
plugin in 2026.6.1:
  - managedFlows.finish()/fail() are pure store writes; the only transition hook
    (`configureTaskFlowRegistryStore` observer) is registered ONLY in tests — no production
    code delivers on a flow transition.
  - Real terminal delivery (`maybeDeliverTaskTerminalUpdate`) fires only for TASK records
    with a linked parentFlowId, not for a bare managed flow.
  - scheduleSessionTurn is hard-gated to origin==="bundled" (no-op for us) — already noted
    at §10.2; this is why the detached wakeup never produced a cron_jobs/delivery row.
  - The tool execute() ctx exposes no caller sessionKey/deliveryContext; only the tool
    FACTORY ctx (OpenClawPluginToolContext) carries them, which the SDK tool-plugin entry
    does not pass to execute.
So the robust, ungated path is PULL: detached flows bind a stable DETACHED_OWNER_KEY and a
new `action:"status", id:<flowId>` reads the persisted stateJson. VERIFIED: a detached
`return "PONGPULL"` persisted {status:done,result:PONGPULL}; the agent autonomously polled
status from the tool's return instruction and retrieved PONGPULL; a separate status call
(different toolCallId) returned {id, status:"done", result:"PONGPULL"}.

REMAINING HONEST GAPS:
- Push completion to the user session needs an OpenClaw change (ungate a delivery seam for
  external plugins, or expose caller origin to tool execute). Until then PULL/status is the
  contract. Documented, not worked around.
- Canvas (needs a paired UI node) and the human approval hook remain headless-blocked.
