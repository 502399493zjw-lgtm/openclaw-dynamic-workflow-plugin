export type AgentView = { label: string; status: string };
export type PhaseView = { name: string; agents: AgentView[] };

// Build A2UI v0.8 JSONL: one surfaceUpdate with a Column of phase/agent Text rows, then beginRendering.
export function buildPhaseTreeA2UI(phases: PhaseView[]): string {
  const surfaceId = "main";
  const rootId = "root";
  const rows: Array<{ id: string; component: unknown }> = [];
  const childIds: string[] = [];

  phases.forEach((phase, pi) => {
    const phaseId = `phase-${pi}`;
    childIds.push(phaseId);
    rows.push({
      id: phaseId,
      component: { Text: { text: { literalString: `▸ ${phase.name}` }, usageHint: "title" } },
    });
    phase.agents.forEach((agent, ai) => {
      const agentId = `phase-${pi}-agent-${ai}`;
      childIds.push(agentId);
      rows.push({
        id: agentId,
        component: {
          Text: { text: { literalString: `   • ${agent.label} [${agent.status}]` }, usageHint: "body" },
        },
      });
    });
  });

  const payloads = [
    {
      surfaceUpdate: {
        surfaceId,
        components: [
          { id: rootId, component: { Column: { children: { explicitList: childIds } } } },
          ...rows,
        ],
      },
    },
    { beginRendering: { surfaceId, root: rootId } },
  ];
  return payloads.map((p) => JSON.stringify(p)).join("\n");
}
