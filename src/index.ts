// Plugin entry. Registers the `workflow` tool via the verified SDK surface.
// See docs/superpowers/plans/api-findings.md for the exact contracts proven
// against the installed openclaw package.
import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { spawnAwaitCollect } from "./skeleton/spawn-bridge.js";

export default defineToolPlugin({
  id: "workflows",
  name: "Dynamic Workflows",
  description: "Claude-Code-style dynamic workflows: orchestrate many sub-agents from an LLM-written script.",
  tools: (tool) => [
    tool({
      name: "workflow",
      label: "Dynamic Workflow",
      description: "Run a dynamic workflow (skeleton: spawns one sub-agent and returns its output).",
      parameters: Type.Object({
        task: Type.String({ description: "Task for the spawned sub-agent." }),
      }),
      execute: async (params, _config, context) => {
        const { task } = params;
        const sessionKey = `agent:main:subagent:workflow-${context.toolCallId}`;

        context.onUpdate?.({
          content: [],
          details: undefined,
          progress: {
            text: "spawning 1 sub-agent",
            visibility: "channel",
            privacy: "public",
            id: "wf:spawn",
          },
        });

        const { status, output } = await spawnAwaitCollect(
          context.api.runtime.subagent,
          sessionKey,
          task,
        );

        context.onUpdate?.({
          content: [],
          details: undefined,
          progress: {
            text: `child ${status}`,
            visibility: "channel",
            privacy: "public",
            id: "wf:done",
          },
        });

        return output;
      },
    }),
  ],
});
