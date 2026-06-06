import { describe, it, expect } from "vitest";
import { Type } from "typebox";
import { typeboxValidator } from "./typebox-validator.js";

describe("typeboxValidator", () => {
  const schema = Type.Object({ ok: Type.Boolean(), n: Type.Number() });
  it("parses valid JSON matching the schema", () => {
    const v = typeboxValidator(schema);
    const r = v(`{"ok":true,"n":3}`);
    expect(r).toEqual({ ok: true, value: { ok: true, n: 3 } });
  });
  it("rejects JSON that violates the schema", () => {
    const v = typeboxValidator(schema);
    expect(v(`{"ok":"yes"}`).ok).toBe(false);
  });
  it("rejects non-JSON text", () => {
    const v = typeboxValidator(schema);
    expect(v(`not json`).ok).toBe(false);
  });
});
