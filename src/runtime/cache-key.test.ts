import { describe, it, expect } from "vitest";
import { agentCacheKey } from "./cache-key.js";

describe("agentCacheKey", () => {
  const base = { scriptHash: "abc", args: { a: 1 }, callSite: "phase:scan#3", prompt: "audit x" };

  it("is stable for identical inputs", () => {
    expect(agentCacheKey(base)).toBe(agentCacheKey({ ...base }));
  });

  it("changes when the prompt changes", () => {
    expect(agentCacheKey(base)).not.toBe(agentCacheKey({ ...base, prompt: "audit y" }));
  });

  it("changes when args change", () => {
    expect(agentCacheKey(base)).not.toBe(agentCacheKey({ ...base, args: { a: 2 } }));
  });

  it("is order-independent for args object keys", () => {
    const k1 = agentCacheKey({ ...base, args: { a: 1, b: 2 } });
    const k2 = agentCacheKey({ ...base, args: { b: 2, a: 1 } });
    expect(k1).toBe(k2);
  });
});
