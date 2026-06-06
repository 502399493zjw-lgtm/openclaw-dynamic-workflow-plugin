import { buildPhaseTreeA2UI, type PhaseView } from "./phase-tree-a2ui.js";
import type { WorkflowEvent } from "../runtime/workflow-runtime.js";

export type NodesInvoke = (params: {
  nodeId: string;
  command: string;
  params: { jsonl: string };
}) => Promise<unknown>;

export function createCanvasSurface(opts: { nodesInvoke: NodesInvoke; nodeId?: string }) {
  const phases: PhaseView[] = [];
  const byName = new Map<string, PhaseView>();
  const phaseOf = (name: string) => {
    let p = byName.get(name);
    if (!p) { p = { name, agents: [] }; byName.set(name, p); phases.push(p); }
    return p;
  };

  const onEvent = (e: WorkflowEvent) => {
    if (e.type === "phase") phaseOf(e.name);
    else if (e.type === "agent:start") phaseOf(e.phase).agents.push({ label: e.label, status: "running" });
    else if (e.type === "agent:done") {
      const a = phaseOf(e.phase).agents.find((x) => x.label === e.label);
      if (a) a.status = e.status;
    }
  };

  const flush = async () => {
    if (!opts.nodeId) return; // headless: no paired canvas node, nothing to render
    const jsonl = buildPhaseTreeA2UI(phases);
    await opts.nodesInvoke({ nodeId: opts.nodeId, command: "canvas.a2ui.pushJSONL", params: { jsonl } });
  };

  return { onEvent, flush };
}
