// The real `workflow` tool: a thin adapter from the OpenClaw tool-execution
// contract onto the orchestration engine (`runWorkflow`). The engine fans out
// sub-agents via the injected `api.runtime.subagent` spine and returns one
// coordinated result; we map its typed `WorkflowEvent`s onto `context.onUpdate`
// progress (shape verified in api-findings.md §4).
//
// REGISTRATION: this module exports the *tool definition object* only. The
// plugin entry (src/index.ts) keeps the verified `defineToolPlugin` path
// (api-findings.md §2 — the path the live 2026.6.1 gateway loaded, §8) and
// feeds this definition through its `tools: (tool) => [tool(...)]` factory. The
// execution context is the SDK's own `ToolPluginExecutionContext` so the
// `api.runtime.subagent` spine and `onUpdate` shapes match exactly (this is the
// same surface the proven skeleton used).
import { Type } from "typebox";
import type { ToolPluginExecutionContext } from "openclaw/plugin-sdk/tool-plugin";
import { runWorkflow, type WorkflowEvent } from "./runtime/workflow-runtime.js";
import { typeboxValidator } from "./runtime/typebox-validator.js";

function progress(ctx: ToolPluginExecutionContext, text: string, id: string): void {
  // `AgentToolResult` shape (api-findings.md §4): content + details + progress,
  // where progress carries visibility:"channel" / privacy:"public".
  ctx.onUpdate?.({
    content: [],
    details: undefined,
    progress: { text, visibility: "channel", privacy: "public", id },
  });
}

export function createWorkflowTool() {
  return {
    name: "workflow",
    label: "Dynamic Workflow",
    description:
      "Execute a dynamic workflow: a JS orchestration script using agent()/parallel()/pipeline()/phase()/log() that fans out sub-agents and returns one coordinated result.",
    parameters: Type.Object({
      script: Type.String({
        description: "JS orchestration script body (no imports; uses the injected primitives).",
      }),
      args: Type.Optional(Type.Any()),
    }),
    // TODO(Plan #3): hand the engine off to a detached/background task run
    // (`createRunningTaskRun`/`completeTaskRunByRunId`) once the accessor is
    // pinned in api-findings. For Plan #2 we run inline within `execute` (the
    // tool is already long-running) and never block the return value on it.
    execute: async (
      params: { script: string; args?: unknown },
      _config: unknown,
      ctx: ToolPluginExecutionContext,
    ): Promise<unknown> => {
      let agentCount = 0;
      const onEvent = (e: WorkflowEvent): void => {
        if (e.type === "phase") {
          progress(ctx, `phase: ${e.name}`, `wf:phase:${e.name}`);
        } else if (e.type === "agent:start") {
          agentCount += 1;
          progress(ctx, `running ${agentCount} agent(s) — ${e.label}`, "wf:agents");
        } else if (e.type === "log") {
          progress(ctx, e.message, "wf:log");
        }
      };

      const result = await runWorkflow({
        script: params.script,
        args: params.args,
        subagent: ctx.api.runtime.subagent,
        baseSessionKey: `agent:main:subagent:wf-${ctx.toolCallId}`,
        concurrency: 16,
        onEvent,
        schemaValidatorFactory: (schema) => typeboxValidator(schema as never),
      });

      progress(ctx, `done — ${agentCount} agent(s)`, "wf:done");
      return result;
    },
  };
}
