// Host bridge for the walking skeleton: spawn one isolated sub-agent, block (in
// code) until it finishes, then read its final assistant text.
//
// VERIFIED against the real SDK (see docs/superpowers/plans/api-findings.md §3):
// the in-gateway spine is `api.runtime.subagent`, NOT a raw GatewayClient. The
// injected runtime exposes run → waitForRun → getSessionMessages. We depend only
// on that narrow surface so this stays unit-testable with a fake.

/** The narrow slice of `api.runtime.subagent` this bridge needs. */
export type SubagentRuntime = {
  run: (params: {
    sessionKey: string;
    message: string;
    provider?: string;
    model?: string;
    deliver?: boolean;
  }) => Promise<{ runId: string }>;
  waitForRun: (params: {
    runId: string;
    timeoutMs?: number;
  }) => Promise<{ status: "ok" | "error" | "timeout"; error?: string }>;
  getSessionMessages: (params: {
    sessionKey: string;
    limit?: number;
  }) => Promise<{ messages: unknown[] }>;
};

export type SpawnAwaitCollectResult = {
  status: "ok" | "error" | "timeout";
  output: string;
};

// `getSessionMessages` returns `messages: unknown[]`, so narrow each row
// defensively to the assistant-text shape before reading it.
function extractAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    const record = msg as { role?: unknown; content?: unknown };
    if (record.role !== "assistant") continue;
    return contentToText(record.content);
  }
  return "";
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block && typeof block === "object") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string") return text;
      }
      return "";
    })
    .join("");
}

/**
 * Spawn one sub-agent on `sessionKey`, await its terminal status in code, then
 * collect the last assistant message's text. Pure orchestration over the
 * injected subagent runtime — no global state, no direct gateway socket.
 */
export async function spawnAwaitCollect(
  subagent: SubagentRuntime,
  sessionKey: string,
  task: string,
  timeoutMs = 120_000,
): Promise<SpawnAwaitCollectResult> {
  const { runId } = await subagent.run({
    sessionKey,
    message: task,
    deliver: false,
  });

  const waited = await subagent.waitForRun({ runId, timeoutMs });

  const { messages } = await subagent.getSessionMessages({ sessionKey });
  return { status: waited.status, output: extractAssistantText(messages) };
}
