import { agentCacheKey } from "./cache-key.js";

export function createResumeJournal(opts: {
  read: () => Promise<Record<string, unknown>>;
  write: (entries: Record<string, unknown>) => Promise<void>;
  scriptHash: string;
  args: unknown;
}) {
  const key = (k: { callSite: string; prompt: string }) =>
    agentCacheKey({ scriptHash: opts.scriptHash, args: opts.args, callSite: k.callSite, prompt: k.prompt });
  return {
    get: async (k: { callSite: string; prompt: string }) => (await opts.read())[key(k)],
    put: async (k: { callSite: string; prompt: string }, value: unknown) => {
      await opts.write({ [key(k)]: value });
    },
  };
}
