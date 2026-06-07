import { createContext, Script } from "node:vm";

export async function runScript(opts: {
  source: string;
  primitives: Record<string, unknown>;
  args: unknown;
  budget: unknown;
}): Promise<unknown> {
  // SECURITY MODEL — READ THIS. node:vm is NOT a security boundary (Node's own docs
  // say so; verified here: `agent.constructor.constructor("return process")()` reaches
  // host `process` despite codeGeneration:false, because the injected primitives are
  // host-realm functions whose constructor is the host Function). This context only
  // removes the AMBIENT host globals (require/process/fs aren't in scope), which stops
  // ACCIDENTAL host access and is a speed-bump against naive escapes — nothing more.
  // The REAL controls (same model as Claude Code's workflow tool) are: (1) the script
  // is authored by a trusted, aligned agent, and (2) the before_tool_call approval gate
  // (src/index.ts) puts a human in the loop per run. Do NOT rely on this vm to contain a
  // hostile script. If this plugin is ever deployed multi-user or exposed to untrusted
  // script authors, replace this with a real isolate (isolated-vm) or a sandboxed
  // subprocess — see docs/superpowers/plans/api-findings.md §16.
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
