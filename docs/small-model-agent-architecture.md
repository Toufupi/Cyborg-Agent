# Small-Model Agent Architecture

Status: product architecture draft

## Goal

Cyborg-Agent should be driveable by small, low-cost models.

The system should avoid designs that require tens of thousands of tokens for every action. A small model should be able to inspect a short tool summary, pick a registered tool, send A2C2A JSON, repair structured errors, and finish recurring work.

Large models should be available, but reserved for:

- new tool creation;
- ambiguous planning;
- difficult repair;
- summarization that exceeds the small model's ability;
- fallback when the small model fails.

## Primary Use Case

Scheduled personal intelligence tasks:

- latest research progress;
- daily news brief;
- GitHub release monitoring;
- arXiv paper watch;
- security advisory watch;
- market or product tracking;
- weekly generated report.

Example: latest research progress collection.

```text
schedule: every day 08:00
topic: AI agents and tool use
sources:
  - arXiv
  - Semantic Scholar
  - selected RSS feeds
  - GitHub trending/search
output:
  - short markdown report
  - optional Page-Generator-CLI HTML page
model:
  default: small
  fallback: large
```

The recurring task should mostly run from code and config. The model should only decide, summarize, repair, or escalate.

## Agent Loop Status

Implemented v0.1 loop:

```text
goal
  -> compact context of tools and tasks
  -> OpenAI-compatible chat completion with JSON response_format
  -> validated step JSON
  -> inspect_context | inspect_tool | inspect_run | create_tool | run_task | call_tool | answer | final
  -> A2C2A tool execution or discovery command
  -> observation appended to history
  -> next model step
  -> structured repair attempt on A2C2A errors
  -> run history
```

The model-facing plan is intentionally tiny:

```json
{
  "kind": "call_tool",
  "tool": "page-generator-cli",
  "request": {
    "a2c2a": "0.1",
    "action": "page.render",
    "input": {}
  },
  "confidence": 0.8,
  "reason": "registered page generation tool"
}
```

This is the key shift from runtime skeleton to agent behavior: Cyborg can now ask a model what to do, validate that decision, execute a registered deterministic capability, and feed structured errors back for repair.

The loop is multi-step. A small model can inspect a selected tool manifest before constructing the A2C2A request, then read the tool result before producing a final answer.

The loop can now start self-improvement work. `create_tool` delegates local Node A2C2A scaffolding to the built-in `tool-builder` subagent, registers the result when requested, runs doctor, and returns a compact observation containing the new tool path, subagent run, and A2A transcript. `inspect_run` gives the model compact access to previous run history. This is not unrestricted autonomous coding; it is the first durable code-knowledge step with lifecycle and audit evidence.

Implemented v0.2 additions:

- `cyborg model --smoke` verifies the selected OpenAI-compatible endpoint can return JSON.
- Repair attempts are recorded with model name, plan, exit code, and error type.
- Automatic fallback can route later repair attempts to the large model when `max_retries_exceeded` is configured.
- `cyborg tool create <name>` uses the same built-in `tool-builder` subagent path as planner `create_tool`, creating a local Node A2C2A tool scaffold under `tools/<name>`.
- `research-fetcher` provides the first research/news fetch-normalize tool contract.
- `cyborg agent run <profile> <task> --worker planner` lets a subagent run through the planner loop instead of only deterministic task execution.

Implemented v0.3 additions:

- `cyborg task schedule --once` runs due tasks and updates scheduler state.
- `cyborg task schedule --watch --interval <ms>` keeps a lightweight polling daemon in the foreground.
- `research-fetcher` can call arXiv, GitHub repository search, RSS/Atom feeds, direct feed URLs, or deterministic sample sources.
- policy includes network mode and host allowlist fields.
- guarded invocations write JSONL audit events.
- subagent profiles include `timeout_ms` and `max_concurrency`; status files include pid and can be marked cancelled.

Tool-builder subagent evidence:

- run directory: `.cyborg/runs/agent-tool-builder-*`
- lifecycle status: `subagent-status.json`
- A2A transcript: `a2a.json` with `delegate`, `accept`, and `result` or `error`
- planner observation: compact `toolRoot`, `registrationFile`, `doctor`, `run`, and `a2a`

## Context Budget Strategy

Do not put everything into the prompt.

Use layered discovery:

1. Tool index: name, domain, short description.
2. Tool help: only when a tool is selected.
3. Tool manifest: only for the selected action.
4. Component/action schema: only the relevant part.
5. Full docs: only on failure or tool creation.

This allows small models to operate with a tiny context window.

## Code Tool Definition

Tools should be organized semantically and categorically.

Suggested directory shape:

```text
.cyborg/
  tools/
    page-generator-cli.json
    research-fetcher.json
  tasks/
    research-progress.daily.json
  runs/
    2026-04-29/
  memory/
    sources/
    summaries/
```

Registration categories:

```json
{
  "name": "research-fetcher",
  "capabilities": {
    "domains": ["research", "news"],
    "categories": ["fetch", "deduplicate", "summarize"],
    "outputs": ["json", "markdown"]
  }
}
```

Naming rules:

- tool names should be semantic: `research-fetcher`, `page-generator-cli`;
- actions should be verb-based: `research.fetch`, `research.summarize`, `page.render`;
- categories should be stable and low-cardinality;
- descriptions should be short enough for a small model index.

## Language And Runtime

The standard is language-neutral, but v0.1 is Node-first.

Why Node first:

- current implementation is already Node;
- Page-Generator-CLI is Node;
- tool registry and runner are TypeScript;
- frontend/report generation fits Node well.

Python backend should be planned as a runtime extension:

```text
runtime.type=node    supported first
runtime.type=python  planned
```

The abstraction is already in the registration format, so adding Python later should not require changing how tools are discovered.

## Dependency And Environment Strategy

Tools must be as plug-in-like as skills, but executable.

Each tool registration should declare:

- runtime type;
- version requirement;
- install mode;
- command invocation;
- required environment variables;
- whether it requires Cyborg shell.

Implemented for v0.1:

- Node tools use `package.json` and lockfiles;
- local tools declare `runtime.cwd`, `package_manager`, `install_strategy`, and `isolated`;
- packaged tools can be called directly, for example `pagegen`;
- Cyborg-Agent should not guess dependencies.
- `cyborg tool doctor <name>` checks runtime health;
- `cyborg tool env <name>` prints a compact machine-readable runtime summary;
- `cyborg tool install <name>` runs the declared package manager in the tool runtime cwd.

Future:

- Python tools can declare venv or uv requirements;
- tool-env installation strategy can move external repos into Cyborg-managed environments.

## Two-Model Strategy

Cyborg-Agent should support two model profiles:

```json
{
  "models": {
    "small": {
      "base_url": "http://localhost:11434/v1",
      "api_key_env": "CYBORG_SMALL_MODEL_KEY",
      "model": "small-model-name"
    },
    "large": {
      "base_url": "https://api.example.com/v1",
      "api_key_env": "CYBORG_LARGE_MODEL_KEY",
      "model": "large-model-name"
    },
    "routing": {
      "mode": "auto",
      "fallback_on": [
        "schema_repair_failed",
        "tool_not_found",
        "low_confidence",
        "max_retries_exceeded"
      ]
    }
  }
}
```

Routing modes:

```text
small_only
large_only
auto
manual
```

Default should be `auto`:

1. Try small model.
2. If it cannot build valid A2C2A JSON, repair with small model.
3. If repair exceeds retry limit, escalate to large model.
4. Save the successful procedure as code/config so the next run is cheaper.

## Scheduler As A First-Class Feature

Scheduled tasks are not an add-on. They are the natural fit for this architecture.

Suggested commands:

```powershell
cyborg task add research-progress.daily.json
cyborg task list
cyborg task run research-progress
cyborg task schedule
cyborg task history research-progress
```

Task config shape:

```json
{
  "name": "research-progress",
  "schedule": "0 8 * * *",
  "model_profile": "auto",
  "tools": ["research-fetcher", "page-generator-cli"],
  "goal": "Collect latest research progress for AI agents and produce a short report.",
  "outputs": {
    "markdown": "reports/research-progress.md",
    "html": "reports/research-progress.html"
  }
}
```

The scheduler should store run results and errors in `.cyborg/runs`.

## Agent Loop For Scheduled Research

```text
load task config
  -> load compact tool index
  -> small model selects tools
  -> fetch sources with code tools
  -> deduplicate and rank with code
  -> small model summarizes
  -> generate report with Page-Generator-CLI
  -> if validation fails, repair A2C2A JSON
  -> if repeated failure, fallback to large model
  -> save artifacts and run log
```

## First Implementation Plan

1. Keep `cyborg tool` registry as the foundation.
2. Add model profile config.
3. Add task config schema.
4. Add manual `cyborg task run <name>` before daemon scheduling.
5. Implement one reference scheduled task: research progress report.
6. Add automatic fallback from small model to large model.

This gives us a practical personal Agent without requiring a giant context window.

## Current v0.1 Implementation

Implemented commands:

```powershell
cyborg init
cyborg config
cyborg env
cyborg doctor
cyborg ask "run the research progress report"
cyborg context
cyborg model --reason fallback
cyborg model --smoke
cyborg tool list
cyborg tool create research-fetcher
cyborg tool add examples\research-fetcher-tool.json
cyborg tool info page-generator-cli
cyborg tool help page-generator-cli render
cyborg tool manifest page-generator-cli
cyborg tool call page-generator-cli --request request.json
cyborg tool doctor page-generator-cli
cyborg tool env page-generator-cli
cyborg tool install page-generator-cli
cyborg task add examples\research-progress.daily.json
cyborg task run research-progress
cyborg task history research-progress
cyborg task schedule --once
cyborg task schedule --watch --interval 60000
cyborg hook list
cyborg policy show
cyborg approval list
cyborg agent list
cyborg agent run researcher research-progress
cyborg agent run researcher research-progress --worker planner
cyborg agent cancel .cyborg\runs\agent-researcher-...\subagent-status.json
cyborg audit list
cyborg tui
```

The current `research-progress` demo uses Page-Generator-CLI to prove the task/config/tool/run-log loop. Hooks, agent profiles, A2A transcripts, subagent lifecycle status, policy checks, approvals, runtime isolation, and a model-driven planner/repair loop are implemented at v0.1 level.

The next tool should be `research-fetcher`, which will turn the static demo payload into real source collection.
