const FORBIDDEN = [
  /\brequire\s*\(/,
  /\bimport\s*\(/,
  /\bprocess\b/,
  /\bglobalThis\b/,
  /\bfetch\s*\(/,
  /\b(child_process|fs|net|http|https|os|vm)\b/,
];

export type ScriptValidation = { ok: true } | { ok: false; reason: string };

export function validateScript(source: string): ScriptValidation {
  for (const pattern of FORBIDDEN) {
    if (pattern.test(source)) return { ok: false, reason: `forbidden token: ${pattern}` };
  }
  return { ok: true };
}
