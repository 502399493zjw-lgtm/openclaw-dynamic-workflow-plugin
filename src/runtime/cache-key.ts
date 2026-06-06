import { createHash } from "node:crypto";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const body = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",");
  return `{${body}}`;
}

export function agentCacheKey(input: {
  scriptHash: string;
  args: unknown;
  callSite: string;
  prompt: string;
}): string {
  const canonical = stableStringify({
    scriptHash: input.scriptHash,
    args: input.args,
    callSite: input.callSite,
    prompt: input.prompt,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
