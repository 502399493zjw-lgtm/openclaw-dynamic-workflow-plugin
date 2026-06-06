// Plugin entry. Registers the real runtime-backed `workflow` tool via the
// verified SDK surface. See docs/superpowers/plans/api-findings.md for the exact
// contracts proven against the installed openclaw package.
//
// We keep the `defineToolPlugin` path (api-findings.md §2 — it auto-derives the
// `contracts.tools` manifest and is the path the isolated 2026.6.1 dev gateway
// actually loaded, §8). The tool definition itself lives in workflow-tool.ts and
// is fed through this plugin's `tools: (tool) => [tool(...)]` factory.
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { createWorkflowTool } from "./workflow-tool.js";

export default defineToolPlugin({
  id: "workflows",
  name: "Dynamic Workflows",
  description: "Claude-Code-style dynamic workflows: orchestrate many sub-agents from an LLM-written script.",
  tools: (tool) => [tool(createWorkflowTool())],
});
