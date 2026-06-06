import { describe, it, expect } from "vitest";
import { validateScript } from "./validate-script.js";

describe("validateScript", () => {
  it("accepts a script that only uses the workflow primitives", () => {
    const ok = `const r = await agent("hi"); log(r); return r;`;
    expect(validateScript(ok)).toEqual({ ok: true });
  });

  it("rejects require()", () => {
    const r = validateScript(`const fs = require("fs");`);
    expect(r.ok).toBe(false);
  });

  it("rejects dynamic import and process/fs/child_process access", () => {
    expect(validateScript(`await import("fs");`).ok).toBe(false);
    expect(validateScript(`process.exit(1);`).ok).toBe(false);
    expect(validateScript(`globalThis.fetch("http://x");`).ok).toBe(false);
  });
});
