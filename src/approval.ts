// Approval gate for the `workflow` tool (Plan #3 Task 3.2).
//
// Sanctioned plugin path (api-findings.md §9.5 / §10.4): a plugin calls
// `api.on("before_tool_call", handler)`; returning `{ requireApproval: {...} }`
// makes OpenClaw create a `plugin:`-prefixed pending approval, deliver it to the
// approval surfaces, and BLOCK the tool call until the user resolves it. We key
// on `toolName === "workflow"` so only our own dynamic-workflow tool is gated.
//
// Types are pinned to the REAL `before_tool_call` contract (api-findings.md
// §10.4, verified in node_modules/openclaw/dist/hook-types-eDvaxJMP.d.ts:552,580):
//   - `PluginHookBeforeToolCallEvent.params` is a REQUIRED `Record<string, unknown>`
//     (the plan placeholder had it optional; the real event always carries params).
//   - `PluginHookBeforeToolCallResult.requireApproval.severity` is
//     `"info" | "warning" | "critical"` (the plan placeholder used `"warn"`/`"danger"`
//     — those are NOT in the real enum; we use `"warning"`).
// The handler is registered via `api.on("before_tool_call", workflowApprovalHandler as never)`
// in src/index.ts (Plan #3 Step 4); the structural shape below matches the SDK
// type so that cast is sound.

/** Subset of `PluginHookBeforeToolCallEvent` we read (hook-types.ts:552). */
type BeforeToolCall = { toolName: string; params: Record<string, unknown> };

/** Subset of `PluginHookBeforeToolCallResult` we return (hook-types.ts:580). */
type ApprovalResult =
  | {
      requireApproval: {
        title: string;
        description: string;
        severity?: "info" | "warning" | "critical";
      };
    }
  | undefined;

export async function workflowApprovalHandler(call: BeforeToolCall): Promise<ApprovalResult> {
  if (call.toolName !== "workflow") return undefined;
  const script = typeof call.params?.script === "string" ? call.params.script : "";
  const preview = script.length > 600 ? `${script.slice(0, 600)}…` : script;
  return {
    requireApproval: {
      title: "Run dynamic workflow?",
      description: `This will fan out sub-agents per the script:\n\n${preview}`,
      severity: "warning",
    },
  };
}
