export type SavedWorkflowDef = { name: string; script: string; description?: string };
export type SavedWorkflowSummary = { id: string; name: string; description?: string };
export type SavedStoreDeps = {
  save: (id: string, def: SavedWorkflowDef) => Promise<void>;
  load: (id: string) => Promise<SavedWorkflowDef | undefined>;
  // Enumerate saved workflows (id + name + optional description) so the agent can
  // DISCOVER what is saved instead of having to already know an id.
  list: () => Promise<SavedWorkflowSummary[]>;
};
export type WorkflowActionParams = {
  // "status" and "list" are handled upstream in the tool and never reach
  // resolveWorkflowAction; listed here only so the shared param type matches.
  action?: "run" | "save" | "run-saved" | "status" | "list";
  script?: string; args?: unknown; id?: string; name?: string; description?: string;
};
export type ResolvedAction =
  | { kind: "run"; script: string; args: unknown }
  | { kind: "saved"; id: string };

export async function resolveWorkflowAction(p: WorkflowActionParams, deps: SavedStoreDeps): Promise<ResolvedAction> {
  const action = p.action ?? "run";
  if (action === "save") {
    if (!p.id || !p.script) throw new Error("save requires id + script");
    await deps.save(p.id, { name: p.name ?? p.id, script: p.script, description: p.description });
    return { kind: "saved", id: p.id };
  }
  if (action === "run-saved") {
    if (!p.id) throw new Error("run-saved requires id");
    const def = await deps.load(p.id);
    if (!def) throw new Error(`saved workflow not found: ${p.id}`);
    return { kind: "run", script: def.script, args: p.args };
  }
  if (!p.script) throw new Error("run requires script");
  return { kind: "run", script: p.script, args: p.args };
}
