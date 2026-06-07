import { describe, it, expect } from "vitest";
import { resolveWorkflowAction, type SavedWorkflowDef } from "./saved-store.js";

describe("resolveWorkflowAction", () => {
  const store = new Map<string, SavedWorkflowDef>();
  const deps = {
    save: async (id: string, def: SavedWorkflowDef) => { store.set(id, def); },
    load: async (id: string) => store.get(id),
    list: async () => [...store.entries()].map(([id, d]) => ({ id, name: d.name, description: d.description })),
  };
  it("save stores the def incl description; run-saved loads the script + applies args", async () => {
    const saved = await resolveWorkflowAction(
      { action: "save", id: "audit", name: "Audit", description: "auth audit across routes", script: "await agent('x')" },
      deps,
    );
    expect(saved.kind).toBe("saved");
    expect(store.get("audit")).toMatchObject({ name: "Audit", description: "auth audit across routes", script: "await agent('x')" });
    const run = await resolveWorkflowAction({ action: "run-saved", id: "audit", args: { n: 1 } }, deps);
    expect(run.kind).toBe("run");
    if (run.kind !== "run") throw new Error("expected run");
    expect(run.script).toBe("await agent('x')");
    expect(run.args).toEqual({ n: 1 });
  });
  it("run-saved on a missing id errors", async () => {
    await expect(resolveWorkflowAction({ action: "run-saved", id: "nope" }, deps)).rejects.toThrow();
  });
});
