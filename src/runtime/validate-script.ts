// A SPEED-BUMP, NOT A SECURITY BOUNDARY. These patterns reject the obvious ways a
// script reaches the host (accidental or naive-malicious). They are trivially
// bypassable with obfuscation (string-splitting, computed property access), so they
// are NOT what keeps a hostile script out — that is the trusted-agent + human-approval
// model (see src/runtime/sandbox.ts and src/index.ts). They exist to catch mistakes
// and raise the bar, nothing more.
const FORBIDDEN = [
  /\brequire\s*\(/,
  /\bimport\s*\(/,
  /\bprocess\b/,
  /\bglobalThis\b/,
  /\bfetch\s*\(/,
  /\b(child_process|fs|net|http|https|os|vm)\b/,
  // Prototype-chain escape vectors: `agent.constructor.constructor("…")()`, the
  // bare Function/eval constructors, and computed `["constructor"]` access.
  /\bconstructor\b/,
  /\bFunction\s*\(/,
  /\beval\s*\(/,
  /\[\s*["'`]\s*(?:constructor|__proto__|prototype)\s*["'`]\s*\]/,
  /\b__proto__\b/,
];

export type ScriptValidation = { ok: true } | { ok: false; reason: string };

export function validateScript(source: string): ScriptValidation {
  for (const pattern of FORBIDDEN) {
    if (pattern.test(source)) return { ok: false, reason: `forbidden token: ${pattern}` };
  }
  return { ok: true };
}
