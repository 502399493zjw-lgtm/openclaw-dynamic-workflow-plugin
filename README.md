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

```bash
# from ClawHub (or: npm:openclaw-plugin-workflows, or a local checkout)
openclaw plugins install clawhub:openclaw-plugin-workflows
openclaw gateway restart
openclaw plugins inspect workflows   # confirm Status: loaded
```

Local development install:

```bash
git clone <this repo> && cd openclaw-plugin-workflows
pnpm install && pnpm build
openclaw plugins install --link "$PWD"
openclaw gateway restart
```

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

TBD — choose a license before publishing.
