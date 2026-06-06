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
    return scheduler.schedule(async () => {
      emit({ type: "agent:start", phase: myPhase, label, seq: mySeq });
      const sessionKey = `${opts.baseSessionKey}:${myPhase}:${mySeq}`;
      const runOnce = async (correction?: string) => {
        const message = correction ? `${prompt}\n\n${correction}` : prompt;
        return spawnAwaitCollect(opts.subagent, sessionKey, message);
      };
      try {
        if (agentOpts?.schema && opts.schemaValidatorFactory) {
          const validate = opts.schemaValidatorFactory(agentOpts.schema);
          const value = await runWithSchema({
            run: async (corr) => (await runOnce(corr)).output,
            validate,
            maxRetries: 2,
          });
          emit({ type: "agent:done", phase: myPhase, label, seq: mySeq, status: value == null ? "invalid" : "ok" });
          return value;
        }
        const r = await runOnce();
        emit({ type: "agent:done", phase: myPhase, label, seq: mySeq, status: r.status });
        return r.status === "ok" ? r.output : null;
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
