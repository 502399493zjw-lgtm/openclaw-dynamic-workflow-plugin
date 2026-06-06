# Workflow script examples

These are **orchestration script bodies** — what the OpenClaw agent writes and the `workflow` tool runs in its sandbox. The injected globals are `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`. No `import`/`require`/`fs`/`shell`/network. `agent()` returns the sub-agent's text (or a validated object with `schema`, or `null` on failure).

> Reminder: ≤16 concurrent sub-agents, ≤1000 total per run. `parallel()` is a barrier; `pipeline()` streams items independently. Failed agents return `null` — filter with `.filter(Boolean)`.

---

## 1. Parallel fan-out (barrier)

Summarize many files at once, then combine.

```js
phase("summarize");
const summaries = await parallel(
  args.files.map((file) => () => agent(`Summarize ${file} in one sentence.`)),
);

phase("combine");
const overview = await agent(
  `Write a 3-bullet overview from these file summaries:\n${summaries.filter(Boolean).join("\n")}`,
);
return overview;
```

Invoke: `args = { files: ["src/a.ts", "src/b.ts", "src/c.ts"] }`.

---

## 2. Pipeline (no-barrier streaming)

Each item flows through all stages independently — a fast item reaches stage 2 while a slow one is still in stage 1. A stage receives `(prevResult, originalItem, index)`.

```js
return await pipeline(
  args.urls,
  // stage 1: fetch + extract (one sub-agent per url)
  async (_prev, url) => agent(`Fetch ${url} and extract its main claim in one line.`),
  // stage 2: fact-check that claim
  async (claim, url) => {
    if (!claim) return null;
    log(`checking ${url}`);
    return agent(`Is this claim well-supported? "${claim}". Reply SUPPORTED or DUBIOUS + why.`);
  },
);
```

---

## 3. Structured output (`schema`)

Force each agent to return a validated object (re-prompts up to 2× on mismatch). Pass any TypeBox/JSON schema.

```js
// The host injects a TypeBox-backed validator; describe the shape in the prompt.
const reviews = await parallel(
  args.prs.map((pr) => () =>
    agent(
      `Review PR #${pr}. Return JSON {"pr": number, "risk": "low"|"med"|"high", "reason": string}.`,
      { schema: { type: "object", required: ["pr", "risk", "reason"],
                  properties: { pr: { type: "number" },
                                risk: { enum: ["low", "med", "high"] },
                                reason: { type: "string" } } },
        label: `review:${pr}` },
    ),
  ),
);
return reviews.filter(Boolean).filter((r) => r.risk !== "low");
```

---

## 4. Adversarial verification (the quality pattern)

Don't trust a single pass — have independent skeptics try to *refute* each finding; keep it only if the majority can't.

```js
phase("find");
const candidates = (await parallel(
  args.files.map((f) => () => agent(`Find one security bug in ${f}, or reply "none".`)),
)).filter((x) => x && !/^none/i.test(x));

phase("verify");
const judged = await parallel(
  candidates.map((finding) => () =>
    parallel([
      () => agent(`Refute this bug or confirm it real: "${finding}". Reply REAL or REFUTED.`),
      () => agent(`Independently: is "${finding}" a real exploitable bug? REAL or REFUTED.`),
      () => agent(`Skeptic pass: try hard to REFUTE "${finding}". REAL or REFUTED.`),
    ]).then((votes) => ({
      finding,
      real: votes.filter(Boolean).filter((v) => /REAL/i.test(v)).length >= 2,
    })),
  ),
);
return judged.filter((j) => j.real).map((j) => j.finding);
```

This is the "moves the plan into code" advantage: the loop, the voting, and the intermediate findings all stay in script variables; only the confirmed list returns.

---

## 5. Using `budget`

Scale depth to a token budget (hard ceiling — exceeding it stops new spawns).

```js
const found = [];
let round = 0;
while (budget.remaining() > 50_000 && round < 5) {
  round += 1;
  const more = await parallel(
    Array.from({ length: 4 }, (_, i) => () => agent(`Find edge case #${round}.${i} in the spec.`)),
  );
  found.push(...more.filter(Boolean));
  log(`round ${round}: ${found.length} found, ${Math.round(budget.remaining() / 1000)}k left`);
}
return found;
```

---

## 6. Save and re-run

Save a script once, then re-run it later with fresh input — no need to resend the script.

```text
# save (the agent calls the tool with action:"save")
action: "save", id: "auth-audit", name: "Auth audit",
script: "<the script from example 1 or 4>"

# run later with different files
action: "run-saved", id: "auth-audit", args: { files: ["src/routes/x.ts", "src/routes/y.ts"] }
```

---

## Notes

- `parallel()` preserves input order; `pipeline()` returns results in input order too.
- A re-run of the same script + same `args` reuses already-completed sub-agent results (resume journal), so interrupted runs don't redo finished work.
- Keep prompts self-contained: each sub-agent runs in its own isolated session and only sees what you put in its prompt.
