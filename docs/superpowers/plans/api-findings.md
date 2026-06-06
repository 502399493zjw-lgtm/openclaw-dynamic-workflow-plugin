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
- Live gateway load + live PONG test: **BLOCKED** by the gateway running `2026.1.30`, whose dist
  lacks the plugin-SDK entry modules and the `inspect`/`--link` CLI surface. See blockers[].
</content>
