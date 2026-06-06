import { describe, it, expect } from "vitest";
import { buildPhaseTreeA2UI } from "./phase-tree-a2ui.js";

type PhaseView = { name: string; agents: Array<{ label: string; status: string }> };

describe("buildPhaseTreeA2UI", () => {
  const phases: PhaseView[] = [
    { name: "scan", agents: [{ label: "file1", status: "done" }, { label: "file2", status: "running" }] },
    { name: "verify", agents: [{ label: "claim1", status: "queued" }] },
  ];

  it("emits one JSON object per line, each with exactly one A2UI action key", () => {
    const jsonl = buildPhaseTreeA2UI(phases);
    const lines = jsonl.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const ACTIONS = ["beginRendering", "surfaceUpdate", "dataModelUpdate", "deleteSurface", "createSurface"];
    for (const line of lines) {
      const obj = JSON.parse(line);
      const keys = ACTIONS.filter((k) => k in obj);
      expect(keys.length).toBe(1);
    }
  });

  it("ends with a beginRendering action and references every phase + agent label", () => {
    const jsonl = buildPhaseTreeA2UI(phases);
    const lines = jsonl.split("\n").filter(Boolean);
    expect(JSON.parse(lines[lines.length - 1])).toHaveProperty("beginRendering");
    expect(jsonl).toContain("scan");
    expect(jsonl).toContain("verify");
    expect(jsonl).toContain("file2");
    expect(jsonl).toContain("claim1");
  });
});
