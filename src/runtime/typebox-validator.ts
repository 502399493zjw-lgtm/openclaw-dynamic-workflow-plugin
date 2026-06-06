// TypeBox subpath verified against the installed package (typebox@1.1.39):
// node_modules/typebox/package.json exports "./value" -> ./build/value/index.mjs
// (re-exports `Value` as a namespace). See api-findings.md §1.
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import type { Validator } from "./schema-retry.js";

// Bridges the engine's opaque `schema` to a text `Validator`: parse JSON, then
// check against the TypeBox schema. On failure, surface the first localized error.
// NOTE: typebox@1.1.39's error objects expose `instancePath` + `message`
// (TValidationErrorBase & { message: string }), NOT `path` — verified against
// node_modules/typebox/build/error/errors.d.mts.
export function typeboxValidator(schema: TSchema): Validator<unknown> {
  return (text: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: "output is not valid JSON" };
    }
    if (!Value.Check(schema, parsed)) {
      const first = Value.Errors(schema, parsed)[0];
      const where = first?.instancePath || "(root)";
      return {
        ok: false,
        error: first ? `${where}: ${first.message}` : "schema mismatch",
      };
    }
    return { ok: true, value: parsed };
  };
}
