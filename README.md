# openclaw-plugin-workflows

**Claude-Code-style dynamic workflows for [OpenClaw](https://github.com/openclaw/openclaw) — as a plugin, no core fork.**

Your OpenClaw agent writes a short JavaScript *orchestration script*; a runtime executes it and fans the work out across many isolated OpenClaw sub-agents. Intermediate results live in script variables, so the main conversation only sees the final, coordinated answer. Use it for codebase-wide sweeps, large migrations, and cross-checked research with adversarial verification — things one turn-by-turn conversation can't coordinate.

> **Status: research-preview.** The core is live-proven on a real `openclaw@2026.6.1` gateway (a sub-agent spawn→await→collect round-trip and a real parallel fan-out both pass end-to-end). Some surface/lifecycle pieces are unit-tested and pending manual demo — see [Status & limitations](#status--limitations).

---

## How it works

```
You → your OpenClaw assistant: "use a workflow to audit every route for missing auth"
        │
        ▼  the agent writes a JS script and calls the `workflow` tool (you approve first)
   ┌──────────────────────────────────────────────────────────────┐
   │  workflow runtime (vm-scoped JS — speed-bump, not a boundary)  │
   │    agent() ─► real OpenClaw sub-session (spawn → await → read) │
   │    parallel() / pipeline() ─► fan out (≤16 concurrent)         │
   │    results converge in script variables                        │
   └──────────────────────────────────────────────────────────────┘
        │  progress → tool cards (TUI/WebChat/IM) + Canvas phase-tree
        ▼
   one coordinated answer back in your chat
```

## Requirements

- **OpenClaw `2026.6.1` or newer.** The plugin imports `openclaw/plugin-sdk/*`; older end-user builds (e.g. `2026.1.30`) ship only `plugin-sdk/index.js` and **cannot host this plugin**. Check with `openclaw --version`.
- **Node 22.19+** (OpenClaw's own requirement).

## Install

The repo ships a prebuilt, self-contained `dist/` (typebox bundled in; `openclaw` is a
linked peer), so **no build or `npm install` is needed to use it** — clone and install
from the local path. (`openclaw plugins install <git-url>` is not accepted by openclaw
2026.6.1, so clone first.)

```bash
git clone https://github.com/502399493zjw-lgtm/openclaw-dynamic-workflow-plugin.git
openclaw plugins install ./openclaw-dynamic-workflow-plugin --force
openclaw gateway restart
openclaw plugins inspect workflows   # confirm Status: enabled
```

**Update to a newer version:**

```bash
cd openclaw-dynamic-workflow-plugin && git pull
openclaw plugins install . --force && openclaw gateway restart
```

**Working on the plugin itself** (editing source): `pnpm install && pnpm build` rebuilds
`dist/` (esbuild bundle); commit the rebuilt `dist/` so installs stay build-free.

## Using it

Just ask your assistant in natural language — "**use a workflow to …**", "**fan this out across sub-agents**", etc. The agent writes the script and calls the `workflow` tool; you get an **approval prompt** showing the planned script before anything runs.

The `workflow` tool accepts:

| param | type | meaning |
| --- | --- | --- |
| `action` | `"run"` \| `"save"` \| `"run-saved"` | default `"run"` |
| `script` | string | the orchestration script body (required for `run`/`save`) |
| `args` | any | input data exposed to the script as the global `args` |
| `id` | string | saved-workflow id (for `save` / `run-saved`) |
| `name` | string | human label (for `save`) |

## Writing a workflow script

The script body runs in a `node:vm` context whose only injected globals are the primitives below — ambient `import`/`require`/`fs`/`shell`/network are out of scope. **This is a speed-bump, not a security boundary** (`node:vm` is escapable; see [Security model](#security-model)); the real protection is a trusted authoring agent + the approval gate. The only intended I/O is through these primitives:

| primitive | behavior |
| --- | --- |
| `await agent(prompt, { schema?, label? })` | Spawn one isolated sub-agent; returns its final text. With `schema` (a TypeBox/JSON-schema), returns a **validated object** (re-prompts up to 2× on mismatch). Returns `null` if the agent fails. |
| `await parallel([() => agent(...), ...])` | **Barrier**: start all, resolve when all settle; order preserved; a failed thunk → `null`. |
| `await pipeline(items, stage1, stage2, …)` | **No-barrier streaming**: each item flows through all stages independently; a stage gets `(prevResult, originalItem, index)`. Wall-clock ≈ slowest single chain. |
| `phase(name)` | Open a named phase; subsequent agents group under it (progress + Canvas tree). |
| `log(message)` | Emit a progress line. |
| `args` | The caller-supplied input (or `undefined`). |
| `budget` | `{ total, spent(), remaining() }` token budget (hard ceiling). |

**Limits:** ≤16 concurrent sub-agents, ≤1000 total per run. Sub-agents cannot themselves start workflows (one level of nesting, by design).

### Quick example

```js
// "audit each route file for missing auth, then keep only verified findings"
phase("scan");
const findings = await parallel(
  args.files.map((f) => () => agent(`Does ${f} have a missing auth check? Answer the file + a one-line reason, or "clean".`)),
);

phase("verify");
const confirmed = await parallel(
  findings.filter((x) => x && !/clean/i.test(x)).map((finding) => () =>
    agent(`A reviewer claims: "${finding}". Try to REFUTE it. Reply REAL or FALSE-POSITIVE with one line.`),
  ),
);

return confirmed.filter((v) => v && /REAL/i.test(v));
```

See **[docs/examples.md](docs/examples.md)** for more (pipeline, structured `schema` output, the adversarial-verify pattern, save/run-saved).

## Surfaces

- **Progress** streams as typed tool-progress → live tool cards on every OpenClaw surface (TUI, WebChat, IM channels).
- **Canvas phase-tree panel**: when a Canvas-capable node is paired, a live phase→agent tree renders via `canvas.a2ui.pushJSONL`.
- **Approval gate**: the run is held until you approve (shows the planned script).

## Watching sub-agents live

The interesting work happens *inside* the script — dozens of sub-agents the main chat never
shows you. Set **`OPENCLAW_WORKFLOWS_TRACE=1`** (or a file path) on the process that runs
workflows — the **gateway** for `openclaw agent` / remote `tui`, or your **shell** for
`openclaw chat --local` — and each run appends JSONL events (`run:start`; `agent:start` with
the prompt preview + first-response timeout; `agent:done` with status + duration; `run:done`)
to `$OPENCLAW_HOME/workflow-trace.jsonl`. Tail it in a second terminal with the bundled
monitor:

```
$ node scripts/wf-monitor.mjs

🧩 workflow run · started 19:08:28
  ▶ #1 scan-auth   ⏱120s  "Does routes/admin.ts have a missing auth check?…"
  ▶ #2 scan-pay    ⏱120s  "Does routes/pay.ts have a missing auth check?…"
  ✓ #2 scan-pay    done (5s)
  ✗ #1 scan-auth   timeout (120s) — first-response window exceeded
  ── run complete ──
```

The trace is **opt-in and side-effect-free** — no env var, nothing written. It's an
observability hook, not part of the result path.

## Save & resume

- `action: "save"` stores a script under an `id`; `action: "run-saved"` replays it with fresh `args`. Saved defs persist in an OpenClaw managed-flow store.
- A **resume journal** (keyed by script + args + call-site) lets a re-run reuse already-completed sub-agent results instead of re-spawning them.

## Security model

The `node:vm` context is **not** a security boundary — it is escapable (a host-realm
`Function` is reachable through the injected primitives), so it only stops *accidental*
host access and naive escapes. The actual safety controls — the **same model as Claude
Code's workflow tool** — are: (1) the script is authored by a **trusted, aligned agent**,
and (2) the **`before_tool_call` approval gate** (default ON) puts a human in the loop
per run. For a personal, single-user, local gateway this is sufficient (escaping the vm
grants nothing you don't already have on your own machine). If you ever deploy this
gateway **multi-user or exposed to untrusted script authors**, replace the vm with a real
isolate (`isolated-vm`) or a sandboxed subprocess. See `docs/superpowers/plans/api-findings.md` §16.

## Status & limitations

- **Live-proven** on a real isolated `openclaw@2026.6.1` gateway: the `agent()` spine
  (spawn → in-code await via `agent.wait` → collect), `parallel`/`pipeline` fan-out,
  schema-validated output, per-helper model via a **named agent** (`agent(p,{agent:'id'})`),
  `save` → restart → `run-saved`, and **detached background** (returns a `flowId`, polled
  via `action:"status"`) all return real results end-to-end.
- **Pending manual demo** (not auto-verifiable headless): the Canvas render (needs a paired
  Canvas node) and the interactive approval block (needs a human approver).
- **Detached completion is PULL, not push.** OpenClaw's `scheduleSessionTurn` is trust-gated
  to bundled plugins (a no-op for an externally-installed plugin), so a detached run does
  not push a "finished" turn; the caller retrieves the result with `action:"status"`. Per-call
  `{ model }` overrides are gateway-auth-gated and rejected for our caller — use a **named
  agent** instead (the supported way to pick a model/tools/persona).
- External plugins can't use OpenClaw's trust-gated `openKeyedStore` or core-internal task
  ledger, so background/resume/save run on the sanctioned `api.runtime.tasks.managedFlows`
  surface, with an inline + in-memory fallback when it isn't present.
- Requires `2026.6.1+`; will not load on older end-user builds.

## How it got here (iteration log)

Built spec-first, then hardened against a **real** `openclaw@2026.6.1` gateway — every fix
below came from something breaking in a live run, not a guess. Roughly in order:

**Foundation (spec → spine → runtime).** Design + acceptance rubric first; then the
`agent()` spine (spawn → await → collect) proven end-to-end with a real `PONG`; then the core
runtime (`parallel`/`pipeline`/`phase`/`log`/`budget`) with a live parallel fan-out collecting
every result; then the surfaces (Canvas tree, approval gate, detached, resume journal,
save/run-saved) and per-agent `{ model, agent, schema }` options.

Then real-gateway testing surfaced — and fixed — a series of issues:

| # | What broke in a live run | Fix |
| --- | --- | --- |
| §13 | `api.runtime.subagent` isn't reachable from *inside* the gateway, so `agent()` spawned nothing | Spawn via a **self-connecting `GatewayClient`** (`callGatewayFromCli` → `agent`/`agent.wait`/`chat.history`) |
| save | Saved workflows were keyed to the per-call session and vanished on restart | Rebind the store to a **stable owner key** → `save` survives `gateway restart` → `run-saved` |
| author | Agent-written scripts tripped on `parallel(a, b)` vs `parallel([a, b])` | `parallel()` accepts **varargs or an array**; primitives documented so the authoring agent gets it right unaided |
| detached | `scheduleSessionTurn` (push "finished") is trust-gated to bundled plugins — a no-op for an external one | Detached returns a `flowId`; result is **pulled** via `action:"status"` |
| null | A failed sub-agent collapsed to a bare `null` — even nested `{a:null,b:null}` — with no reason | **Surface the failure reason** at every shape; keep partial text on a non-ok status instead of discarding it |
| **timeout** | **Multi-minute research sub-agents kept returning `null`** — the recurring saga | Root cause: OpenClaw's SDK default **10s RPC first-response timeout**. Fixed: **120s default** first-response window + per-agent **`{ timeout }`** (seconds). This is the fix that made real research work. |
| security | The `node:vm` "sandbox" was implied to be a boundary; it isn't (a host `Function` is reachable) | **Honest model (Option A):** document vm = speed-bump; the real controls are a trusted authoring agent + the approval gate — same as Claude Code |
| review | A `codex` review pass; one suggested RPC-deadline change actually **broke spawns** | Kept the error-observability hardening; **caught the bad change with a live smoke test and reverted it** |
| watch | No way to see the sub-agents executing mid-run | Env-gated **structured trace** + a terminal **monitor** (prompt preview, ⏱timeout, ✓/✗ + duration) — see [Watching sub-agents live](#watching-sub-agents-live) |
| dist | `openclaw 2026.6.1` rejects git-URL installs and doesn't build plugins on install | Ship a **committed self-contained esbuild bundle** (typebox inlined, `openclaw` external) + **clone-and-local-path** install |

The full SDK-contract findings behind each row live in `docs/superpowers/plans/api-findings.md`
(§13–§16).

## Development

```bash
pnpm install
pnpm test          # unit suite (no OpenClaw needed)
pnpm build         # tsc

# live tests (opt-in) against an isolated dev gateway — never the production one:
OPENCLAW_LIVE_TEST=1 OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18790 \
OPENCLAW_GATEWAY_TOKEN=<token> OPENCLAW_HOME=<isolated home> \
pnpm test src/skeleton/spawn-bridge.live.test.ts
```

Design, acceptance rubric, and the verified SDK contract notes live in **[`docs/superpowers/`](docs/superpowers/)** (`specs/` + `plans/`, incl. `plans/api-findings.md`).

## License

MIT — see [LICENSE](LICENSE).
