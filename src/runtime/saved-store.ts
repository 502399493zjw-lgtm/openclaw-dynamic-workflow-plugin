export type SavedStoreDeps = {
  save: (id: string, def: { name: string; script: string }) => Promise<void>;
  load: (id: string) => Promise<{ name: string; script: string } | undefined>;
};
export type WorkflowActionParams = {
  // "status" is handled upstream in the tool (detached-flow poll) and never reaches
  // resolveWorkflowAction; it is listed here only so the shared param type matches.
  action?: "run" | "save" | "run-saved" | "status";
  script?: string; args?: unknown; id?: string; name?: string;
};
export type ResolvedAction =
  | { kind: "run"; script: string; args: unknown }
  | { kind: "saved"; id: string };

export async function resolveWorkflowAction(p: WorkflowActionParams, deps: SavedStoreDeps): Promise<ResolvedAction> {
  const action = p.action ?? "run";
  if (action === "save") {
    if (!p.id || !p.script) throw new Error("save requires id + script");
    await deps.save(p.id, { name: p.name ?? p.id, script: p.script });
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
