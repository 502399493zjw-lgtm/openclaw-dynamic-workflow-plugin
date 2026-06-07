#!/usr/bin/env node
// Live "Lite stream" monitor for workflow sub-agents.
// Reads the structured trace the plugin writes (OPENCLAW_WORKFLOWS_TRACE=1).
//   node wf-monitor.mjs [trace-file]
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const TRACE = process.argv[2] || join(process.env.OPENCLAW_HOME || homedir(), "workflow-trace.jsonl");
const C = { h: "\x1b[1;36m", sp: "\x1b[36m", ok: "\x1b[1;32m", warn: "\x1b[33m", err: "\x1b[1;31m", dim: "\x1b[2m", b: "\x1b[1m", r: "\x1b[0m" };
const t = (ms) => new Date(ms).toTimeString().slice(0, 8);

console.log(`${C.h}┌──────────────────────────────────────────────────┐${C.r}`);
console.log(`${C.h}│${C.r}  ${C.b}👀  Workflow Sub-Agent Monitor${C.r}                    ${C.h}│${C.r}`);
console.log(`${C.h}└──────────────────────────────────────────────────┘${C.r}`);
console.log(`${C.dim}   trace: ${TRACE}  ·  run a workflow elsewhere  ·  Ctrl+C${C.r}`);

const starts = new Map(); // `${run}#${seq}` -> start ms
function render(rec) {
  const key = `${rec.run}#${rec.seq}`;
  switch (rec.type) {
    case "run:start":
      console.log(`\n${C.h}🧩 workflow run${C.r} ${C.dim}· started ${t(rec.t)}${C.r}`);
      console.log(`${C.dim}  ──────────────────────────────────────────────${C.r}`);
      break;
    case "agent:start": {
      starts.set(key, rec.t);
      const to = rec.timeoutSec != null ? `${C.dim}⏱${rec.timeoutSec}s${C.r}` : "";
      const pv = rec.prompt ? `${C.dim}"${rec.prompt}"${C.r}` : "";
      console.log(`  ${C.sp}▶${C.r} ${C.b}#${rec.seq} ${rec.label}${C.r}  ${to}  ${pv}`);
      break;
    }
    case "agent:done": {
      const st = starts.get(key);
      const dur = st != null ? `${Math.round((rec.t - st) / 1000)}s` : "?";
      let icon = `${C.ok}✓${C.r}`, word = "done";
      if (rec.status === "error" || rec.status === "timeout") { icon = `${C.err}✗${C.r}`; word = rec.status; }
      else if (rec.status === "cached") { icon = `${C.dim}⊘${C.r}`; word = "cached"; }
      else if (rec.status === "invalid") { icon = `${C.warn}⚠${C.r}`; word = "schema-invalid"; }
      const why = rec.error ? `${C.dim} — ${String(rec.error).split("\n")[0].slice(0, 52)}${C.r}` : "";
      console.log(`  ${icon} ${C.b}#${rec.seq} ${rec.label}${C.r}  ${word} ${C.dim}(${dur})${C.r}${why}`);
      break;
    }
    case "run:done":
      console.log(`${C.dim}  ── run complete ──${C.r}`);
      break;
  }
}

const tail = spawn("tail", ["-n0", "-F", TRACE]);
let buf = "";
tail.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) { try { render(JSON.parse(line)); } catch { /* skip partial/bad line */ } }
  }
});
tail.stderr.on("data", () => {});
process.on("SIGINT", () => { tail.kill(); process.exit(0); });
