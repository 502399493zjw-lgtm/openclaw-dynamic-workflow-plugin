import { describe, it, expect } from "vitest";
import { workflowApprovalHandler } from "./approval.js";

describe("workflowApprovalHandler", () => {
  it("requires approval for the workflow tool, surfacing the planned script", async () => {
    const r = await workflowApprovalHandler({
      toolName: "workflow",
      params: { script: `phase("scan"); await agent("x");` },
    } as never);
    expect(r?.requireApproval?.title).toMatch(/workflow/i);
    expect(r?.requireApproval?.description).toContain("scan");
  });

  it("ignores non-workflow tools", async () => {
    const r = await workflowApprovalHandler({ toolName: "bash", params: {} } as never);
    expect(r).toBeUndefined();
  });
});
