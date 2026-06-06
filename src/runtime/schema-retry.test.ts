import { describe, it, expect, vi } from "vitest";
import { runWithSchema, type Validator } from "./schema-retry.js";

const evenNumber: Validator<number> = (text) => {
  const n = Number(text);
  if (Number.isInteger(n) && n % 2 === 0) return { ok: true, value: n };
  return { ok: false, error: `not an even integer: ${text}` };
};

describe("runWithSchema", () => {
  it("returns the validated value on first success", async () => {
    const run = vi.fn().mockResolvedValue("4");
    const result = await runWithSchema({ run, validate: evenNumber, maxRetries: 2 });
    expect(result).toBe(4);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retries with the error appended, then succeeds", async () => {
    const run = vi.fn().mockResolvedValueOnce("3").mockResolvedValueOnce("6");
    const result = await runWithSchema({ run, validate: evenNumber, maxRetries: 2 });
    expect(result).toBe(6);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0]).toContain("not an even integer");
  });

  it("returns null after exhausting retries", async () => {
    const run = vi.fn().mockResolvedValue("3");
    const result = await runWithSchema({ run, validate: evenNumber, maxRetries: 2 });
    expect(result).toBeNull();
    expect(run).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});
