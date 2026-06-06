import { createContext, Script } from "node:vm";

export async function runScript(opts: {
  source: string;
  primitives: Record<string, unknown>;
  args: unknown;
  budget: unknown;
}): Promise<unknown> {
  // The sandbox context contains ONLY the injected primitives + args/budget.
  // No require, process, globalThis host, fs, or net is reachable.
  const sandbox: Record<string, unknown> = {
    ...opts.primitives,
    args: opts.args,
    budget: opts.budget,
  };
  const context = createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });
  // Wrap as an async IIFE so `await` and `return` work at top level.
  const wrapped = `(async () => { ${opts.source} })()`;
  const script = new Script(wrapped, { filename: "workflow-script.js" });
  return await script.runInContext(context, { timeout: 60_000 });
}
