import { describe, it, expect } from "vitest";
import { createResumeJournal } from "./resume-journal.js";

describe("createResumeJournal", () => {
  it("returns cached results for seen keys; records new ones", async () => {
    const store: Record<string, unknown> = {};
    const j = createResumeJournal({
      read: async () => store,
      write: async (s) => { Object.assign(store, s); },
      scriptHash: "h", args: { a: 1 },
    });
    const k = { callSite: "scan#1", prompt: "audit x" };
    expect(await j.get(k)).toBeUndefined();
    await j.put(k, "RESULT");
    expect(await j.get(k)).toBe("RESULT");
    // a different prompt is a miss
    expect(await j.get({ callSite: "scan#1", prompt: "audit y" })).toBeUndefined();
  });
});
