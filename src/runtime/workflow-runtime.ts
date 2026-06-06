import { createScheduler } from "./scheduler.js";
import { createBudget } from "./budget.js";
import { runWithSchema, type Validator } from "./schema-retry.js";
import { runScript } from "./sandbox.js";
import { validateScript } from "./validate-script.js";
import { spawnAwaitCollect, type SubagentRuntime } from "../skeleton/spawn-bridge.js";

export type WorkflowEvent =
  | { type: "phase"; name: string }
  | { type: "agent:start"; phase: string; label: string; seq: number }
  | { type: "agent:done"; phase: string; label: string; seq: number; status: string }
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

  const agent = async (prompt: string, agentOpts?: { schema?: unknown; label?: string }): Promise<unknown> => {
    if (spawned >= totalCap) throw new Error(`TotalAgentCap reached (${totalCap})`);
    budget.assertCanSpend();
    spawned += 1;
    const mySeq = (seq += 1);
    const myPhase = phaseName;
    const label = agentOpts?.label ?? `${myPhase}#${mySeq}`;
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
          emit({ type: "agent:start", phase: myPhase, label, seq: mySeq });
          emit({ type: "agent:done", phase: myPhase, label, seq: mySeq, status: "cached" });
          return cached;
        }
      }
      emit({ type: "agent:start", phase: myPhase, label, seq: mySeq });
      const sessionKey = `${opts.baseSessionKey}:${myPhase}:${mySeq}`;
      const runOnce = async (correction?: string) => {
        const message = correction ? `${prompt}\n\n${correction}` : prompt;
        return spawnAwaitCollect(opts.subagent, sessionKey, message);
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
        const output = r.status === "ok" ? r.output : null;
        await record(output);
        emit({ type: "agent:done", phase: myPhase, label, seq: mySeq, status: r.status });
        return output;
      } catch {
        emit({ type: "agent:done", phase: myPhase, label, seq: mySeq, status: "error" });
        return null;
      }
    });
  };

  const parallel = (thunks: Array<() => Promise<unknown>>): Promise<unknown[]> =>
    Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)));

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
