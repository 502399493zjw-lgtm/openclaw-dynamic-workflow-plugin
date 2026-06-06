# openclaw-plugin-workflows

A Claude-Code-style **dynamic workflows** capability for [OpenClaw](https://github.com/openclaw/openclaw), shipped as a standalone plugin (no core fork).

An LLM writes a JS orchestration script; a runtime executes it in the background, fanning out many isolated OpenClaw sub-agents (`agent()` / `parallel()` / `pipeline()`), with intermediate results living in script variables so the main context only holds the final answer. Progress renders across every OpenClaw surface (TUI / WebChat / IM) plus a Canvas phase-tree panel.

**Status:** design approved, pre-implementation.

📄 Design & acceptance spec: [`docs/superpowers/specs/2026-06-06-openclaw-workflows-design.md`](docs/superpowers/specs/2026-06-06-openclaw-workflows-design.md)
