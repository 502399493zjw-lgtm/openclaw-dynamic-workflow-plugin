// Plugin entry. Registers the real runtime-backed `workflow` tool via the
// verified SDK surface. See docs/superpowers/plans/api-findings.md for the exact
// contracts proven against the installed openclaw package.
//
// We keep the `defineToolPlugin` path (api-findings.md §2 — it auto-derives the
// `contracts.tools` manifest and is the path the isolated 2026.6.1 dev gateway
// actually loaded, §8). The tool definition itself lives in workflow-tool.ts and
// is fed through this plugin's `tools: (tool) => [tool(...)]` factory.
//
// Plan #3 Task 3.2 (Step 4): we additionally register a `before_tool_call`
// approval gate (api-findings.md §9.5 / §10.4). `defineToolPlugin` owns its own
// `register(api)` (it calls `api.registerTool(...)` for each tool); we COMPOSE
// onto that register so the tool registration is preserved AND the approval hook
// is added via `api.on("before_tool_call", ...)`. Reassigning `entry.register`
// in place keeps the `toolPluginMetadataSymbol` the SDK stamps on the entry
// (verified in node_modules/openclaw/dist/tool-plugin-DK3hZn5c.js), so the
// auto-derived `contracts.tools` manifest is untouched.
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createWorkflowTool } from "./workflow-tool.js";
import { workflowApprovalHandler } from "./approval.js";

const entry = defineToolPlugin({
  id: "workflows",
  name: "Dynamic Workflows",
  description: "Claude-Code-style dynamic workflows: orchestrate many sub-agents from an LLM-written script.",
  tools: (tool) => [tool(createWorkflowTool())],
});

// Compose the approval hook onto the SDK-generated register. The original
// registers the `workflow` tool; we add the `before_tool_call` gate keyed on
// `toolName === "workflow"` (§10.4 confirms `api.on` is on the register api and
// is typed against `PluginHookHandlerMap["before_tool_call"]`).
const registerTools = entry.register;
entry.register = (api: OpenClawPluginApi): void => {
  registerTools(api);
  // SECURITY CONTROL (default ON). This before_tool_call gate is the workflow plugin's
  // primary safety mechanism — the node:vm sandbox is NOT a real boundary (see
  // src/runtime/sandbox.ts), so a human-in-the-loop approval per run is what actually
  // contains a mis-authored or prompt-injected script. Keep it ON for any gateway that
  // reads untrusted content or is shared/exposed.
  // OPENCLAW_WORKFLOWS_SKIP_APPROVAL=1 removes that human gate. It exists for headless
  // automation (live e2e/CI) and trusted single-user setups where there is no human to
  // resolve the prompt; setting it trades the safety control for convenience, so only
  // use it on a machine + content you fully trust — never on a shared/exposed gateway.
  if (process.env.OPENCLAW_WORKFLOWS_SKIP_APPROVAL !== "1") {
    api.on("before_tool_call", workflowApprovalHandler as never);
  }
};

export default entry;
