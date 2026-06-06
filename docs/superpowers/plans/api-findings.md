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
</content>
