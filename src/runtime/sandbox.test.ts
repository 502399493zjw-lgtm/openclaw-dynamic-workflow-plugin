import { describe, it, expect, vi } from "vitest";
import { runScript } from "./sandbox.js";

describe("runScript", () => {
  it("exposes the injected primitives and returns the script's value", async () => {
    const agent = vi.fn().mockResolvedValue("RESULT");
    const log = vi.fn();
    const value = await runScript({
      source: `const r = await agent("hi"); log(r); return r + "!";`,
      primitives: { agent, log },
      args: undefined,
      budget: null,
    });
    expect(value).toBe("RESULT!");
    expect(agent).toHaveBeenCalledWith("hi");
    expect(log).toHaveBeenCalledWith("RESULT");
  });

  it("exposes args to the script", async () => {
    const value = await runScript({
      source: `return args.map((n) => n * 2);`,
      primitives: {},
      args: [1, 2, 3],
      budget: null,
    });
    expect(value).toEqual([2, 4, 6]);
  });

  it("denies access to host globals (process/require)", async () => {
    await expect(
      runScript({ source: `return process.pid;`, primitives: {}, args: undefined, budget: null }),
    ).rejects.toThrow();
    await expect(
      runScript({ source: `return require("fs");`, primitives: {}, args: undefined, budget: null }),
    ).rejects.toThrow();
  });
});
