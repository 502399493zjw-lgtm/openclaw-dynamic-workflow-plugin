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
- **Only blocker (external, not our bug):** `moonshot` API returned **HTTP 401 Invalid Authentication**
  (verified by raw `curl` to `https://api.moonshot.cn/v1`, 3/3). The key stored in `~/.openclaw/openclaw.json`
  (`sk-`+34 chars) appears stale/placeholder — the StepFun-managed prod gateway likely injects a different
  live credential at runtime. A working model key is required to get the final PONG; the rails (correctly)
  forbid touching StepFun's runtime injection.

**Bottom line:** everything under our control is green — plugin loads + spine runs end-to-end on a real
2026.6.1 gateway. The live PONG needs a valid model credential, which only the user can supply.
</content>
