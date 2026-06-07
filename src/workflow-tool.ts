// The real `workflow` tool: a thin adapter from the OpenClaw tool-execution
// contract onto the orchestration engine (`runWorkflow`). The engine fans out
// sub-agents via the injected `api.runtime.subagent` spine and returns one
// coordinated result; we map its typed `WorkflowEvent`s onto `context.onUpdate`
// progress (shape verified in api-findings.md §4).
//
// REGISTRATION: this module exports the *tool definition object* only. The
// plugin entry (src/index.ts) keeps the verified `defineToolPlugin` path
// (api-findings.md §2 — the path the live 2026.6.1 gateway loaded, §8) and
// feeds this definition through its `tools: (tool) => [tool(...)]` factory. The
// execution context is the SDK's own `ToolPluginExecutionContext` so the
// `api.runtime.subagent` spine and `onUpdate` shapes match exactly (this is the
// same surface the proven skeleton used).
//
// Plan #3 Step-4 wiring (Tasks 3.4 + 3.5 + 3.6 + the surface side of 3.1):
//   - `action` param parsed via `resolveWorkflowAction` (run/save/run-saved).
//   - When `api.session?.workflow?.scheduleSessionTurn` + `api.runtime.tasks
//     .managedFlows` are present, run DETACHED (return "started" immediately) and
//     back the resume journal + saved-store on managedFlow `stateJson`. When they
//     are absent (e.g. unit ctx / older runtime), fall back to inline-await — the
//     Plan #2 behavior — with an in-memory journal/saved-store.
//   - A Canvas surface (3.1) is wired onto the event stream: we resolve a paired
//     canvas nodeId from `api.runtime.nodes` (undefined → the surface is a no-op).
// All cross-cutting deps are accessed through optional chaining + narrow casts so
// the tool stays type-clean (the SDK surfaces are deep optionals on the unit ctx).
import { Type } from "typebox";
import type { ToolPluginExecutionContext } from "openclaw/plugin-sdk/tool-plugin";
import { createHash } from "node:crypto";
import { runWorkflow, type WorkflowEvent, type ResumeJournal } from "./runtime/workflow-runtime.js";
import { typeboxValidator } from "./runtime/typebox-validator.js";
import { resolveWorkflowAction, type SavedStoreDeps } from "./runtime/saved-store.js";
import { runDetached, type ManagedFlows, type ScheduleSessionTurn, type JsonValue } from "./runtime/detached.js";
import { createResumeJournal } from "./runtime/resume-journal.js";
import { createCanvasSurface, type NodesInvoke } from "./surface/canvas-surface.js";
import { createGatewaySubagent } from "./skeleton/gateway-subagent.js";

function progress(ctx: ToolPluginExecutionContext, text: string, id: string): void {
  // `AgentToolResult` shape (api-findings.md §4): content + details + progress,
  // where progress carries visibility:"channel" / privacy:"public".
  ctx.onUpdate?.({
    content: [],
    details: undefined,
    progress: { text, visibility: "channel", privacy: "public", id },
  });
}

// ---------------------------------------------------------------------------
// Narrow accessor types for the deep-optional SDK surfaces. We never assume
// these exist on the ctx; everything is resolved defensively at runtime.
// ---------------------------------------------------------------------------

/** §10.1: session-bound `BoundTaskFlowRuntime` slice we use for journal/saved state. */
type BoundFlowRuntime = ManagedFlows & {
  get: (flowId: string) => { flowId: string; revision: number; stateJson?: unknown } | undefined;
  list: () => Array<{ flowId: string; revision: number; controllerId?: string; stateJson?: unknown }>;
  setWaiting: (params: {
    flowId: string;
    expectedRevision: number;
    stateJson?: JsonValue | null;
  }) => { applied: boolean };
};

/** §10.1: `api.runtime.tasks.managedFlows` entry seam (`bindSession` variant). */
type PluginManagedFlows = {
  bindSession: (params: { sessionKey: string }) => BoundFlowRuntime;
};

type NodesApi = {
  list: (params?: { connected?: boolean }) => Promise<{
    nodes: Array<{ nodeId: string; connected?: boolean; caps?: string[]; commands?: string[] }>;
  }>;
  invoke: (params: { nodeId: string; command: string; params?: unknown }) => Promise<unknown>;
};

function getManagedFlows(api: unknown): PluginManagedFlows | undefined {
  const tasks = (api as { runtime?: { tasks?: { managedFlows?: unknown } } })?.runtime?.tasks;
  const mf = tasks?.managedFlows as PluginManagedFlows | undefined;
  return typeof mf?.bindSession === "function" ? mf : undefined;
}

function getScheduleSessionTurn(api: unknown): ScheduleSessionTurn | undefined {
  const fn = (api as { session?: { workflow?: { scheduleSessionTurn?: unknown } } })?.session?.workflow
    ?.scheduleSessionTurn;
  return typeof fn === "function" ? (fn as ScheduleSessionTurn) : undefined;
}

function getNodes(api: unknown): NodesApi | undefined {
  const nodes = (api as { runtime?: { nodes?: unknown } })?.runtime?.nodes as NodesApi | undefined;
  return typeof nodes?.list === "function" && typeof nodes?.invoke === "function" ? nodes : undefined;
}

// ---------------------------------------------------------------------------
// managedFlow-backed JSON store. A single controller flow (by `controllerId`)
// holds a JSON object map in its `stateJson`; reads list-and-match the flow,
// writes use the optimistic-concurrency `setWaiting({expectedRevision})` mutator
// (§10.1 — there is no bare setter). Best-effort: any failure degrades to an
// empty/no-op store so the run still proceeds.
// ---------------------------------------------------------------------------
function createFlowStore(flows: BoundFlowRuntime, controllerId: string) {
  const findFlow = (): { flowId: string; revision: number; stateJson?: unknown } | undefined => {
    try {
      return flows.list().find((f) => f.controllerId === controllerId);
    } catch {
      return undefined;
    }
  };
  const ensureFlow = (): { flowId: string; revision: number; stateJson?: unknown } | undefined => {
    const existing = findFlow();
    if (existing) return existing;
    try {
      const created = flows.createManaged({
        controllerId,
        goal: `workflow store: ${controllerId}`,
        stateJson: {},
      });
      return { flowId: created.flowId, revision: created.revision, stateJson: {} };
    } catch {
      return undefined;
    }
  };
  const readMap = (): Record<string, JsonValue> => {
    const flow = findFlow();
    const state = flow?.stateJson;
    return state && typeof state === "object" && !Array.isArray(state)
      ? ({ ...(state as Record<string, JsonValue>) })
      : {};
  };
  const writeMap = (next: Record<string, JsonValue>): void => {
    const flow = ensureFlow();
    if (!flow) return;
    try {
      flows.setWaiting({ flowId: flow.flowId, expectedRevision: flow.revision, stateJson: next });
    } catch {
      /* best-effort persistence */
    }
  };
  return { readMap, writeMap };
}

function inMemoryStore() {
  const map: Record<string, JsonValue> = {};
  return {
    readMap: () => ({ ...map }),
    writeMap: (next: Record<string, JsonValue>) => {
      for (const k of Object.keys(next)) map[k] = next[k]!;
    },
  };
}

// Process-level fallback saved-store used only when managedFlows is unavailable
// (degraded mode / unit ctx). MUST be module-scoped, not per-execute — otherwise
// `save` writes to a fresh map that the next call's `run-saved` cannot see.
// Still non-durable (lost on restart), but at least consistent within a process.
const fallbackSavedStore = inMemoryStore();

// ---------------------------------------------------------------------------
// Canvas node resolution (§9.3 / §10.5). List connected nodes, pick the one
// advertising a `canvas.*` command/cap. 0 matches → undefined (the surface
// becomes a no-op). Best-effort: any failure → undefined.
// ---------------------------------------------------------------------------
async function resolveCanvasNodeId(nodes: NodesApi | undefined): Promise<string | undefined> {
  if (!nodes) return undefined;
  try {
    const { nodes: list } = await nodes.list({ connected: true });
    const match = list.find(
      (n) =>
        n.connected !== false &&
        ((n.commands ?? []).some((c) => c.startsWith("canvas.")) ||
          (n.caps ?? []).includes("canvas")),
    );
    return match?.nodeId;
  } catch {
    return undefined;
  }
}

const SAVED_CONTROLLER = "workflows:saved";
const JOURNAL_CONTROLLER_PREFIX = "workflows:journal:";
// Stable owner key for the durable saved-workflow store. Fixed (not per-call) so
// every `save`/`run-saved`/`list` shares one flow_runs row that survives restarts.
const SAVED_OWNER_KEY = "agent:main:workflows-saved";
// Stable owner key for DETACHED run flows, for the same reason: a later
// `action:"status"` call (different toolCallId → different baseSessionKey) must be
// able to find the flow created by the original detached run. Binding detached flows
// to a fixed owner lets get(flowId) resolve them across calls + restarts.
const DETACHED_OWNER_KEY = "agent:main:workflows-detached";

export function createWorkflowTool() {
  return {
    name: "workflow",
    label: "Dynamic Workflow",
    description:
      "Execute a dynamic workflow: a JS orchestration script using agent()/parallel()/pipeline()/phase()/log() that fans out sub-agents and returns one coordinated result. Supports action=run|save|run-saved.",
    parameters: Type.Object({
      // Discriminated action (Plan #3 §3.6). Default "run".
      action: Type.Optional(
        Type.Union(
          [Type.Literal("run"), Type.Literal("save"), Type.Literal("run-saved"), Type.Literal("status")],
          {
            description:
              "run (default) | save a script under id | run-saved by id | status of a detached run by id (its flowId).",
          },
        ),
      ),
      script: Type.Optional(
        Type.String({
          description:
            "JS orchestration script body (async; no imports; top-level await ok; end with `return <result>`). " +
            "Injected primitives: " +
            "agent(prompt: string, opts?: {schema?, label?, agent?, timeout?}): Promise<string|object> — spawn one sub-agent " +
            "(opts.agent routes to a named agent from agents.list — that is how you pick a different model/tools/persona; " +
            "per-call model overrides are NOT supported; opts.timeout is the first-response window in SECONDS, default 120 — " +
            "raise it for a child that is slow to start, e.g. deep web research or large analysis); " +
            "parallel(...thunks) or parallel([thunks]): Promise<any[]> — run thunks (e.g. () => agent('x')) concurrently; " +
            "pipeline(items: any[], ...stages): Promise<any[]> — run each item through the stage fns; " +
            "phase(name: string) and log(msg: string) for progress. Also: args (the passed args value). " +
            "Required for run/save. Example: return await parallel(() => agent('a'), () => agent('b'));",
        }),
      ),
      args: Type.Optional(Type.Any()),
      id: Type.Optional(Type.String({ description: "Saved-workflow id (required for save/run-saved)." })),
      name: Type.Optional(Type.String({ description: "Human label for a saved workflow (save only)." })),
    }),
    execute: async (
      params: {
        action?: "run" | "save" | "run-saved" | "status";
        script?: string;
        args?: unknown;
        id?: string;
        name?: string;
      },
      _config: unknown,
      ctx: ToolPluginExecutionContext,
    ): Promise<unknown> => {
      const api = ctx.api as unknown;
      const baseSessionKey = `agent:main:subagent:wf-${ctx.toolCallId}`;

      // Resolve the sanctioned plugin surfaces (deep optionals — may be absent on
      // a minimal unit ctx). When BOTH the scheduler and managedFlows are present
      // we run detached + persist on flow stateJson; otherwise inline-await.
      const managedFlows = getManagedFlows(api);
      const scheduleSessionTurn = getScheduleSessionTurn(api);
      // OPENCLAW_WORKFLOWS_INLINE=1 forces synchronous (inline-await) execution even
      // when the detached surfaces exist — used by live e2e to observe the run + its
      // children directly. (Detached works via PULL: it persists the result to the
      // flow's stateJson and the caller polls action:"status"; there is no push
      // completion because scheduleSessionTurn is bundled-gated — see README Security.)
      const detached =
        Boolean(managedFlows && scheduleSessionTurn) &&
        process.env.OPENCLAW_WORKFLOWS_INLINE !== "1";

      const boundFlows = managedFlows ? managedFlows.bindSession({ sessionKey: baseSessionKey }) : undefined;

      // §3.6: saved-store backed by a managedFlow stateJson map (or in-memory).
      // It MUST bind to a stable owner key — NOT baseSessionKey, which embeds the
      // per-call toolCallId. Saved workflows are durable, shared across every
      // `workflow` call and across gateway restarts; binding them to the ephemeral
      // per-call session made `save` write to one owner and `run-saved` read from a
      // different one (→ "saved workflow not found" after restart). A fixed key
      // gives all calls one durable saved-store row in the flow_runs SQLite table.
      const savedBoundFlows = managedFlows
        ? managedFlows.bindSession({ sessionKey: SAVED_OWNER_KEY })
        : undefined;
      const savedBacking = savedBoundFlows
        ? createFlowStore(savedBoundFlows, SAVED_CONTROLLER)
        : fallbackSavedStore;
      const savedDeps: SavedStoreDeps = {
        save: async (id, def) => {
          const map = savedBacking.readMap();
          map[id] = def as unknown as JsonValue;
          savedBacking.writeMap(map);
        },
        load: async (id) => {
          const def = savedBacking.readMap()[id];
          if (def && typeof def === "object" && !Array.isArray(def)) {
            const rec = def as { name?: unknown; script?: unknown };
            if (typeof rec.script === "string") {
              return { name: typeof rec.name === "string" ? rec.name : id, script: rec.script };
            }
          }
          return undefined;
        },
      };

      // Detached run flows bind to the stable DETACHED_OWNER_KEY (see constant) so
      // a later `status` poll can find them. This is the canonical PULL completion
      // path for an externally-installed plugin: OpenClaw's own session-wake
      // (scheduleSessionTurn) is hard-gated to bundled plugins and managedFlows.finish
      // emits NO delivery, so the agent retrieves a detached result by polling here.
      const detachedBoundFlows = managedFlows
        ? managedFlows.bindSession({ sessionKey: DETACHED_OWNER_KEY })
        : undefined;

      // action:"status" → read a detached flow's persisted stateJson and return it.
      if (params.action === "status") {
        if (!params.id) throw new Error("status requires id (the detached flowId)");
        const rec = detachedBoundFlows?.get(params.id);
        if (!rec) return { status: "not_found", id: params.id };
        const state = (rec.stateJson ?? {}) as { status?: string; result?: unknown; error?: unknown };
        return { id: params.id, status: state.status ?? "running", result: state.result, error: state.error };
      }

      // §3.6: resolve the action. save → return immediately; run/run-saved →
      // yield a script + args to feed the engine.
      const resolved = await resolveWorkflowAction(params, savedDeps);
      if (resolved.kind === "saved") {
        progress(ctx, `saved workflow: ${resolved.id}`, "wf:saved");
        return { saved: true, id: resolved.id };
      }
      const script = resolved.script;
      const runArgs = resolved.args;

      // §3.5: resume journal backed by a per-script managedFlow stateJson map
      // (or in-memory). Keyed by agentCacheKey({scriptHash, args, callSite, prompt}).
      const scriptHash = createHash("sha256").update(script).digest("hex").slice(0, 16);
      const journalBacking = boundFlows
        ? createFlowStore(boundFlows, `${JOURNAL_CONTROLLER_PREFIX}${scriptHash}`)
        : undefined;
      const journal: ResumeJournal | undefined = journalBacking
        ? createResumeJournal({
            read: async () => journalBacking.readMap(),
            write: async (entries) => {
              const map = journalBacking.readMap();
              Object.assign(map, entries);
              journalBacking.writeMap(map);
            },
            scriptHash,
            args: runArgs,
          })
        : undefined;

      // §3.1: wire the Canvas surface onto the event stream. nodeId undefined →
      // the surface's flush() is a no-op (headless dev gateway).
      const nodes = getNodes(api);
      const canvasNodeId = await resolveCanvasNodeId(nodes);
      const canvas = createCanvasSurface({
        nodesInvoke: ((nodes?.invoke ?? (async () => undefined)) as unknown) as NodesInvoke,
        nodeId: canvasNodeId,
      });

      let agentCount = 0;
      // Collect sub-agent failure reasons so a workflow that ends up `null` can
      // explain WHY (progress events alone don't reach the calling agent's view).
      const spawnErrors: string[] = [];
      const onEvent = (e: WorkflowEvent): void => {
        canvas.onEvent(e);
        if (e.type === "phase") {
          progress(ctx, `phase: ${e.name}`, `wf:phase:${e.name}`);
        } else if (e.type === "agent:start") {
          agentCount += 1;
          progress(ctx, `running ${agentCount} agent(s) — ${e.label}`, "wf:agents");
        } else if (e.type === "log") {
          progress(ctx, e.message, "wf:log");
        } else if (e.type === "agent:done" && e.error) {
          // Any non-ok done event carrying a reason (error OR timeout) — collect it.
          spawnErrors.push(`${e.label}: ${e.error}`);
        }
        // Push the latest phase tree to the canvas (no-op when headless).
        void canvas.flush();
      };

      // §13: spawn via a self-connecting gateway client (loopback url + token from
      // config) instead of the request-ALS-scoped api.runtime.subagent — which throws
      // once our node:vm sandbox + scheduler defer the call. Same agent/agent.wait/
      // chat.history adapter the live tests prove.
      const gw = (ctx.api as { config?: { gateway?: { port?: number; auth?: { token?: string } } } }).config
        ?.gateway;
      const selfSubagent = createGatewaySubagent({
        url: `ws://127.0.0.1:${gw?.port ?? 18789}`,
        token: gw?.auth?.token,
        idempotencyPrefix: `wf-${ctx.toolCallId}`,
      });
      // Our agent.wait poll budget: at least the gateway's per-agent run budget so a
      // slow sub-agent isn't abandoned by our wait. (The real long-poll is the
      // expectFinal "agent" call, which has NO client deadline — see gateway-subagent;
      // setting one there triggers a 10s timeout that kills even fast spawns.)
      const agentBudgetSec =
        (ctx.api as { config?: { agents?: { defaults?: { timeoutSeconds?: number } } } }).config?.agents
          ?.defaults?.timeoutSeconds ?? 600;
      const spawnTimeoutMs = Math.max(120_000, agentBudgetSec * 1000 + 30_000);
      const run = (): Promise<unknown> =>
        runWorkflow({
          script,
          args: runArgs,
          subagent: selfSubagent,
          baseSessionKey,
          concurrency: 16,
          onEvent,
          spawnTimeoutMs,
          schemaValidatorFactory: (schema) => typeboxValidator(schema as never),
          journal,
        });

      // Whenever ANY sub-agent failed, attach the reasons to the result — even when the
      // script wrapped the failures in an object/array (e.g. `{a: null, b: null}`) so
      // the top-level value isn't itself null. Otherwise the caller sees only the nested
      // `null`s and is left guessing why (timeout / rate limit / rejected override).
      // A fully-successful run (no spawnErrors) returns its raw value unchanged.
      // Applied to BOTH the inline return and the detached persisted result, so an
      // action:"status" poll also gets the reason.
      const finalize = (value: unknown): unknown =>
        spawnErrors.length > 0
          ? { result: value ?? null, error: `sub-agent(s) failed — ${spawnErrors.join("; ")}` }
          : value;

      // §3.4: detached path — return "started" immediately + a flowId the caller
      // polls with action:"status". The flow binds DETACHED_OWNER_KEY (stable) so the
      // later poll resolves it. We still pass scheduleSessionTurn as a best-effort
      // push, but it is a no-op for externally-installed plugins (bundled-gated), so
      // PULL via status is the reliable completion path.
      if (detached && managedFlows && scheduleSessionTurn && detachedBoundFlows) {
        progress(ctx, "starting detached workflow", "wf:detached");
        const started = await runDetached({
          managedFlows: detachedBoundFlows,
          scheduleSessionTurn,
          sessionKey: baseSessionKey,
          run: async () => finalize(await run()) as JsonValue,
        });
        return {
          content: [
            {
              type: "text",
              text:
                `Workflow started in the background (flow ${started.flowId}). ` +
                `Poll for the result with action:"status", id:"${started.flowId}" — do not re-run.`,
            },
          ],
          details: { async: true, status: started.status, taskId: started.flowId, flowId: started.flowId },
        };
      }

      // Inline-await fallback (Plan #2 behavior).
      const result = await run();
      await canvas.flush();
      progress(ctx, `done — ${agentCount} agent(s)`, "wf:done");
      return finalize(result);
    },
  };
}
