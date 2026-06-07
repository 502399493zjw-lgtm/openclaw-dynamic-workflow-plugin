import { createScheduler } from "./scheduler.js";
import { createBudget } from "./budget.js";
import { runWithSchema, type Validator } from "./schema-retry.js";
import { runScript } from "./sandbox.js";
import { validateScript } from "./validate-script.js";
import { spawnAwaitCollect, type SubagentRuntime } from "../skeleton/spawn-bridge.js";

export type WorkflowEvent =
  | { type: "phase"; name: string }
  | { type: "agent:start"; phase: string; label: string; seq: number; prompt?: string; timeoutSec?: number }
  | { type: "agent:done"; phase: string; label: string; seq: number; status: string; error?: string }
  | { type: "log"; phase: string; message: string };

/**
 * Resume journal (Plan #3 Task 3.5): an optional store keyed by a stable
 * `{callSite, prompt}` cache key (Plan #1 `agentCacheKey`, applied inside
 * `createResumeJournal`). On a re-run, an `agent()` call whose key is already
 * present returns the cached output WITHOUT spawning a sub-agent; only missing
 * agents re-spawn. `get` returns `undefined` on a miss. The engine treats the
 * journal as best-effort — any failure inside it must not abort the run.
 */
export type ResumeJournal = {
  get: (k: { callSite: string; prompt: string }) => Promise<unknown>;
  put: (k: { callSite: string; prompt: string }, value: unknown) => Promise<void>;
};

export type RunWorkflowOpts = {
  script: string;
  args?: unknown;
  subagent: SubagentRuntime;
  baseSessionKey: string;
  concurrency?: number;
  totalCap?: number;
  budgetTotal?: number | null;
  onEvent?: (e: WorkflowEvent) => void;
  // How long to wait (ms) for each spawned sub-agent to terminate before giving up.
  // MUST be >= the gateway's per-agent run budget (agents.defaults.timeoutSeconds),
  // else a legitimately slow sub-agent (e.g. one doing many web fetches) is abandoned
  // early and falsely reported as a timeout. The tool sets this from config; the
  // 120s spawn-bridge default is only a last-resort fallback for unit tests.
  spawnTimeoutMs?: number;
  // Wires `schema` (opaque to the engine) to a text validator; the tool injects a TypeBox-backed factory.
  schemaValidatorFactory?: (schema: unknown) => Validator<unknown>;
  // Optional resume journal (Plan #3 §3.5). When present, `agent()` checks it
  // before spawning and records successful results into it.
  journal?: ResumeJournal;
};

export async function runWorkflow(opts: RunWorkflowOpts): Promise<unknown> {
  const check = validateScript(opts.script);
  if (!check.ok) throw new Error(`Illegal workflow script: ${check.reason}`);

  const scheduler = createScheduler({ limit: Math.min(opts.concurrency ?? 16, 16) });
  const budget = createBudget(opts.budgetTotal ?? null);
  const totalCap = opts.totalCap ?? 1000;
  let phaseName = "main";
  let seq = 0;
  let spawned = 0;
  const emit = (e: WorkflowEvent) => opts.onEvent?.(e);

  const agent = async (
    prompt: string,
    agentOpts?: {
      schema?: unknown;
      label?: string;
      model?: string;
      provider?: string;
      system?: string;
      agent?: string;
      // First-response timeout in SECONDS for this one sub-agent (default ~120s).
      // Raise it for a child that is slow to start (deep web research, big analysis).
      timeout?: number;
    },
  ): Promise<unknown> => {
    if (spawned >= totalCap) throw new Error(`TotalAgentCap reached (${totalCap})`);
    budget.assertCanSpend();
    spawned += 1;
    const mySeq = (seq += 1);
    const myPhase = phaseName;
    const label = agentOpts?.label ?? `${myPhase}#${mySeq}`;
    // Observability: a single-line prompt preview + the effective first-response
    // timeout (default 120s; see createGatewaySubagent) carried on agent:start.
    const promptPreview = prompt.replace(/\s+/g, " ").trim().slice(0, 100);
    const timeoutSec = agentOpts?.timeout ?? 120;
    // §3.5: a resume re-run keys cached agent results by `{callSite, prompt}`.
    const journalKey = { callSite: `${myPhase}#${mySeq}`, prompt };
    return scheduler.schedule(async () => {
      // §3.5: cache hit → return the cached output WITHOUT spawning a sub-agent.
      // Best-effort: any journal read failure falls through to a real spawn.
      if (opts.journal) {
        let cached: unknown;
        try {
          cached = await opts.journal.get(journalKey);
        } catch {
          cached = undefined;
        }
        if (cached !== undefined) {
          emit({ type: "agent:start", phase: myPhase, label, seq: mySeq, prompt: promptPreview, timeoutSec });
          emit({ type: "agent:done", phase: myPhase, label, seq: mySeq, status: "cached" });
          return cached;
        }
      }
      emit({ type: "agent:start", phase: myPhase, label, seq: mySeq, prompt: promptPreview, timeoutSec });
      // api-findings §12: targeting `agentOpts.agent` runs the child AS that
      // pre-configured OpenClaw agent — it inherits that agent's model + tool policy
      // (resolved from the sessionKey `agent:<id>:` prefix), with no per-call override
      // or auth gate. Default keeps the caller's agent (baseSessionKey, agent:main).
      const baseKey = agentOpts?.agent
        ? opts.baseSessionKey.replace(/^agent:[^:]+:/, `agent:${agentOpts.agent}:`)
        : opts.baseSessionKey;
      const sessionKey = `${baseKey}:${myPhase}:${mySeq}`;
      // Per-agent overrides: `system` → `extraSystemPrompt` (additive persona);
      // model/provider gated by operator config at the gateway (not our concern).
      const runOptions = {
        model: agentOpts?.model,
        provider: agentOpts?.provider,
        extraSystemPrompt: agentOpts?.system,
        // `timeout` is author-facing seconds → the spawn bridge wants ms.
        rpcTimeoutMs: agentOpts?.timeout !== undefined ? agentOpts.timeout * 1000 : undefined,
      };
      const runOnce = async (correction?: string) => {
        const message = correction ? `${prompt}\n\n${correction}` : prompt;
        return spawnAwaitCollect(opts.subagent, sessionKey, message, opts.spawnTimeoutMs, runOptions);
      };
      // §3.5: record a successful result into the journal (best-effort).
      const record = async (value: unknown): Promise<void> => {
        if (!opts.journal || value == null) return;
        try {
          await opts.journal.put(journalKey, value);
        } catch {
          /* journal write is best-effort; never fail the run on it */
        }
      };
      try {
        if (agentOpts?.schema && opts.schemaValidatorFactory) {
          const validate = opts.schemaValidatorFactory(agentOpts.schema);
          const value = await runWithSchema({
            run: async (corr) => (await runOnce(corr)).output,
            validate,
            maxRetries: 2,
          });
          await record(value);
          emit({ type: "agent:done", phase: myPhase, label, seq: mySeq, status: value == null ? "invalid" : "ok" });
          return value;
        }
        const r = await runOnce();
        if (r.status !== "ok") {
          // Don't swallow a non-ok spawn silently — the user sees only `null`
          // otherwise and cannot tell why. Include the gateway's failure reason
          // (r.error) when present (e.g. a rejected model override, billing error).
          const why = r.error ? `: ${r.error}` : "";
          emit({ type: "log", phase: myPhase, message: `agent ${label} did not complete (${r.status})${why}` });
        }
        // Keep any collected text even on a non-ok status: a sub-agent that hit a
        // tool error or a soft timeout often still produced a usable final answer,
        // and discarding it (returning null) loses real content. Only fall to null
        // when there is genuinely no text to return.
        const hasText = typeof r.output === "string" && r.output.trim().length > 0;
        const output = hasText ? r.output : r.status === "ok" ? r.output : null;
        await record(output);
        // Carry the reason on agent:done for a no-text failure so the tool can report it.
        const doneError = !hasText && r.status !== "ok" ? r.error ?? r.status : undefined;
        emit({ type: "agent:done", phase: myPhase, label, seq: mySeq, status: r.status, error: doneError });
        return output;
      } catch (err) {
        // A thrown spawn error (e.g. the gateway rejecting a per-call model/provider
        // override) was previously swallowed into a bare `null`. Surface the reason
        // via a log event + the agent:done error field so it reaches the user.
        const reason = err instanceof Error ? err.message : String(err);
        const hint = /overrides are not authorized/i.test(reason)
          ? " — per-call model/provider override needs operator.admin; define a named agent in agents.list and use agent(prompt, { agent: 'id' }) instead"
          : "";
        emit({ type: "log", phase: myPhase, message: `agent ${label} failed: ${reason}${hint}` });
        emit({ type: "agent:done", phase: myPhase, label, seq: mySeq, status: "error", error: reason + hint });
        return null;
      }
    });
  };

  // Accept BOTH parallel([t1, t2]) (single-array, Claude-Code style) AND
  // parallel(t1, t2) (varargs). A real LLM authoring a script naturally reaches for
  // varargs; the old array-only signature killed those runs with the opaque
  // "thunks.map is not a function". Normalize, then validate with an actionable error.
  const parallel = (...args: Array<unknown>): Promise<unknown[]> => {
    const thunks = (args.length === 1 && Array.isArray(args[0]) ? args[0] : args) as Array<
      () => Promise<unknown>
    >;
    if (!thunks.every((t) => typeof t === "function")) {
      throw new TypeError(
        "parallel() expects thunks (functions), e.g. parallel(() => agent('a'), () => agent('b')) " +
          "or parallel([() => agent('a'), () => agent('b')]).",
      );
    }
    return Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)));
  };

  type Stage = (prev: unknown, item: unknown, index: number) => Promise<unknown>;
  const pipeline = (items: unknown[], ...stages: Stage[]): Promise<unknown[]> =>
    Promise.all(
      items.map((item, i) =>
        stages
          .reduce<Promise<unknown>>((acc, stage) => acc.then((prev) => stage(prev, item, i)), Promise.resolve(item))
          .catch(() => null),
      ),
    );

  const phase = (name: string) => {
    phaseName = name;
    emit({ type: "phase", name });
  };
  const log = (message: string) => emit({ type: "log", phase: phaseName, message });

  return runScript({
    source: opts.script,
    primitives: { agent, parallel, pipeline, phase, log },
    args: opts.args,
    budget: { total: budget.total, spent: budget.spent, remaining: budget.remaining },
  });
}
