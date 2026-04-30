# Cyborg-Agent

Cyborg-Agent is an Agent pattern: **half LLM, half code scheduler**.

The core idea is that an Agent should not store all knowledge in prompts. When a method becomes repeatable, the Agent should turn it into code, save it, test it, version it, and call it again later. Prompts remain useful for reasoning and adaptation; code becomes the durable memory of how work is actually done.

The product goal is small-model automation. Cyborg-Agent should avoid designs that require tens of thousands of prompt tokens per step. A small, cheap model should be able to discover compact tool metadata, call code through A2C2A, repair structured errors, and run recurring tasks almost for free.

## Why This Exists

Large models are creative, but they are not naturally deterministic. The same instruction can produce different outputs. Code gives us the opposite properties: stable execution, reproducible behavior, clear errors, and version history.

Cyborg-Agent combines both:

- LLM for planning, judgment, language, and new task understanding;
- code for reliable execution, validation, transformation, generation, and automation;
- A2C2A for the protocol boundary between the two.

In this model, the Agent becomes a dispatcher of tools it can understand, repair, and extend.

Primary target scenarios:

- daily news collection;
- latest research progress tracking;
- paper and GitHub release monitoring;
- scheduled report generation;
- personal automation that should run cheaply and repeatedly.

## Architecture

```text
User goal
   |
   v
Cyborg Agent
   |
   +-- decide whether existing code can solve the task
   |
   +-- call tool through A2C2A JSON
   |      |
   |      +-- validate JSON
   |      +-- validate input contract
   |      +-- run script/API/CLI
   |      +-- return result or structured error
   |
   +-- repair input, compose tools, or create new code
   |
   v
Result + reusable code knowledge
```

## Repository Role

This repository will hold the reference Agent implementation and orchestration experiments.

It depends conceptually on:

- `A2C2A`: the protocol used to call deterministic code and receive repairable errors.
- `Page-Generator-CLI`: a concrete tool family where the Agent composes validated page components instead of free-form HTML guesses.

## Expected Capabilities

- register local scripts as callable tools;
- inspect each tool's A2C2A manifest and input contract;
- generate valid JSON calls for tools;
- repair calls using `json_parse_error`, `input_validation_error`, and `runtime_error` responses;
- save newly created scripts as reusable knowledge;
- use version control to evolve scripts when tasks change;
- keep expensive online LLM work focused on new coding and hard reasoning, while local execution handles repeatable workflows.

## Tool Registry

Cyborg-Agent should treat tools as self-describing executables.

Tool registrations live in:

```text
.cyborg/tools/*.json
```

Each registration should tell the Agent how to run:

- general help, such as `tool --help`;
- command help, such as `tool render --help`;
- a machine-readable manifest;
- an A2C2A stdin endpoint.

Tools can self-install, or Cyborg-Agent can add any registration JSON directly.

Self-install example:

```powershell
cd ..\Page-Generator-CLI
npm run pagegen -- install-cyborg ..\Cyborg-Agent
```

This creates:

```text
.cyborg/tools/page-generator-cli.json
```

Unified management:

```powershell
npm run cyborg -- init
npm run cyborg
npm run cyborg -- chat
npm run cyborg -- config
npm run cyborg -- env
npm run cyborg -- doctor
npm run cyborg -- ask "run the research progress report"
npm run cyborg -- model --smoke
npm run cyborg -- context
npm run cyborg -- model --reason fallback
npm run cyborg -- tool list
npm run cyborg -- tool create my-tool --description "A reusable A2C2A code tool"
npm run cyborg -- tool add examples\research-fetcher-tool.json
npm run cyborg -- tool info page-generator-cli
npm run cyborg -- tool help page-generator-cli
npm run cyborg -- tool help page-generator-cli render
npm run cyborg -- tool manifest page-generator-cli
npm run cyborg -- tool call page-generator-cli --request ..\Page-Generator-CLI\examples\a2c2a-render.json
npm run cyborg -- tool doctor page-generator-cli
npm run cyborg -- tool env page-generator-cli
npm run cyborg -- tool install page-generator-cli
npm run cyborg -- tui --tool page-generator-cli --request ..\Page-Generator-CLI\examples\a2c2a-render.json
npm run cyborg -- hook list
npm run cyborg -- policy list
npm run cyborg -- policy show
npm run cyborg -- approval list
npm run cyborg -- audit list
npm run cyborg -- agent list
npm run cyborg -- agent run researcher research-progress
npm run cyborg -- agent run researcher research-progress --worker planner
npm run cyborg -- agent cancel .cyborg\runs\agent-researcher-...\subagent-status.json
```

Running `npm run cyborg` with no command opens the persistent interactive shell:

```text
Cyborg-Agent interactive shell
Type /help for commands, /exit to quit.
cyborg>
```

First shell commands:

```text
/tools
/tasks
/hooks
/agents
/policies
/approvals
/context
/doctor
/model fallback
/run research-progress
/history research-progress
/call page-generator-cli ..\Page-Generator-CLI\examples\a2c2a-render.json
/tool-help page-generator-cli render
/tool-doctor page-generator-cli
/tool-env page-generator-cli
/agent-run researcher research-progress
/exit
```

The shell stores its own `chat-*` session history under `.cyborg/runs`, so later planner work can inspect what happened instead of relying on terminal scrollback.

## Agent Loop

Cyborg-Agent now has a first real agent loop:

```text
natural goal
  -> compact tool/task context
  -> small-model JSON plan
  -> run registered task or call A2C2A tool
  -> if A2C2A returns a structured error, ask the model for a repaired JSON call
  -> save the full session under .cyborg/runs
```

Use it directly:

```powershell
npm run cyborg -- ask "run the research progress report"
```

Or type a normal sentence in the persistent shell. Slash commands stay deterministic; non-command natural language is sent to the planner.

The planner must return one small JSON object:

```json
{ "kind": "run_task", "task": "research-progress", "confidence": 0.9, "reason": "registered task" }
```

or:

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
  "reason": "page tool can render this artifact"
}
```

This keeps the agent small-model-friendly: the model plans in a constrained JSON protocol, and Cyborg executes only known plan types.

Implemented v0.2 agent pieces:

- model smoke check through `cyborg model --smoke`;
- multi-attempt A2C2A repair loop with attempt history;
- automatic large-model fallback when routing policy matches repeated repair failure;
- local Node tool scaffolding through `cyborg tool create`;
- built-in `research-fetcher` A2C2A tool scaffold for research/news report pipelines;
- subagent planner worker mode through `cyborg agent run <agent> <task> --worker planner`.

Implemented v0.3 runtime pieces:

- scheduler scan/daemon mode through `cyborg task schedule --once` and `--watch`;
- execution audit log under `.cyborg/audit/events.jsonl`;
- network policy fields for allow/deny/ask host control;
- subagent timeout, cancellation state, pid metadata, and profile concurrency limit;
- `research-fetcher` sources: `sample`, `arxiv`, `arxiv:<query>`, `rss:<url>`, `github:<query>`, and direct RSS/Atom URLs.

Register the built-in research fetcher:

```powershell
npm run cyborg -- tool add examples\research-fetcher-tool.json
```

Call it:

```powershell
'{"a2c2a":"0.1","action":"research.fetch","input":{"topic":"agent tools","sources":["sample"],"limit":2}}' | npm run cyborg -- tool call research-fetcher
```

## Tool Runtime Isolation

Cyborg-Agent and CLI tools should not share dependency state.

Node tools can declare an isolated runtime in their registration:

```json
{
  "runtime": {
    "type": "node",
    "node": ">=20",
    "cwd": "C:/path/to/Page-Generator-CLI",
    "package_manager": "npm",
    "install_strategy": "external_repo",
    "isolated": true
  }
}
```

Rules:

- Cyborg-Agent keeps its own `node_modules`.
- Each Node tool uses its own `runtime.cwd` and dependency tree.
- Invocation `cwd` may still point at the Cyborg workspace when outputs should land there.
- If an invocation omits `cwd`, Cyborg uses `runtime.cwd`.
- If a tool declares `isolated: true`, it must declare `runtime.cwd`; Cyborg fails before spawning the tool if this contract is missing.
- `tool doctor` checks runtime cwd, `package.json`, `node_modules`, and package manager metadata.
- `tool env` prints the effective runtime cwd, isolation markers, required env keys, and PATH entries Cyborg will prepend.
- `tool install` runs the declared package manager in `runtime.cwd`.

Commands:

```powershell
npm run cyborg -- tool doctor page-generator-cli
npm run cyborg -- tool env page-generator-cli
npm run cyborg -- tool install page-generator-cli
```

This is dependency isolation, not a security sandbox. Security policy still controls commands, env, cwd, approvals, and workspace path guards.

## Hooks

Hooks are small executable lifecycle listeners stored in:

```text
.cyborg/hooks/*.json
```

Hook schema:

```json
{
  "schema": "cyborg.hook.v0.1",
  "name": "audit-log",
  "description": "Capture successful task steps.",
  "enabled": true,
  "events": ["step.ok"],
  "blocking": false,
  "invocation": {
    "command": "node",
    "args": ["scripts/audit-hook.mjs"]
  }
}
```

Hooks receive a JSON event on stdin. The first supported lifecycle events include:

- `task.start`
- `task.end`
- `step.start`
- `step.ok`
- `step.failed`
- `step.error`
- `tool.call`
- `tool.ok`
- `tool.failed`
- `subagent.start`
- `subagent.end`

Commands:

```powershell
npm run cyborg -- hook add hooks\audit-log.json
npm run cyborg -- hook list
```

## Agent Profiles And Subagents

Agent profiles are constrained role configs stored in:

```text
.cyborg/agents/*.json
```

Profile schema:

```json
{
  "schema": "cyborg.agent-profile.v0.1",
  "name": "researcher",
  "description": "Small-model research report agent.",
  "model_profile": "small",
  "allowed_tools": ["page-generator-cli"],
  "allowed_tasks": ["research-progress"],
  "instructions": "Prefer concise evidence-backed reports."
}
```

Profiles can also be created from Markdown descriptor files:

```markdown
---
name: researcher
description: Small-model research report agent.
model_profile: small
policy: research-policy
allowed_tools: [page-generator-cli]
allowed_tasks: [research-progress]
---

Prefer concise evidence-backed reports. Use registered tools instead of
free-form HTML or ad hoc scripts when a tool contract exists.
```

Commands:

```powershell
npm run cyborg -- agent add agents\researcher.md
npm run cyborg -- agent list
npm run cyborg -- agent run researcher research-progress
npm run cyborg -- agent transcript .cyborg\runs\agent-researcher-...\run.json
npm run cyborg -- agent status .cyborg\runs\agent-researcher-...\run.json
```

This is the first lightweight subagent layer. It does not yet create independent LLM workers; it constrains what a named agent profile may run, records a parent `agent-*` run, delegates deterministic task execution through A2C2A, and records parent/subagent communication through A2A.

Each subagent run also writes lifecycle state:

```text
.cyborg/runs/agent-<name>-.../subagent-status.json
```

Status values:

- `starting`
- `running`
- `completed`
- `failed`
- `cancelled`

The status file is intentionally separate from `run.json` and `a2a.json`: `run.json` is the event log, `a2a.json` is the parent/subagent transcript, and `subagent-status.json` is the latest lifecycle snapshot that schedulers or future TUI views can poll cheaply.

## A2A Protocol

A2A is the Agent-to-Agent protocol for parent agent and subagent communication.

The current wire objects are:

```text
cyborg.a2a.message.v0.1
cyborg.a2a.transcript.v0.1
```

Each subagent run writes:

```text
.cyborg/runs/agent-<name>-.../a2a.json
```

Message types:

- `delegate`: parent asks a subagent to handle a task.
- `accept`: subagent accepts the delegated task.
- `progress`: subagent reports intermediate state.
- `result`: subagent returns a successful result.
- `error`: subagent returns a structured failure.
- `cancel`: parent or subagent cancels the conversation.

Minimal message shape:

```json
{
  "schema": "cyborg.a2a.message.v0.1",
  "id": "msg_x",
  "time": "2026-04-30T00:00:00.000Z",
  "conversation_id": "a2a-researcher-x",
  "from": { "agent": "cyborg", "session_id": "agent-researcher-x" },
  "to": { "agent": "researcher" },
  "type": "delegate",
  "task": "research-progress",
  "content": "Create the research progress report.",
  "data": {}
}
```

Inside the interactive shell:

```text
/a2a .cyborg\runs\agent-researcher-...\run.json
/agent-status .cyborg\runs\agent-researcher-...\run.json
```

## Security And Permissions

Cyborg-Agent uses a lightweight policy layer inspired by OpenClaw's separation between tool policy, exec approvals, sandbox/workspace boundaries, environment sanitization, and auditability.

Policies live in:

```text
.cyborg/policies/*.json
```

Minimal policy:

```json
{
  "schema": "cyborg.policy.v0.1",
  "name": "research-policy",
  "security": {
    "mode": "workspace"
  },
  "tools": {
    "allow": ["page-generator-cli"],
    "deny": []
  },
  "tasks": {
    "allow": ["research-progress"],
    "deny": []
  },
  "commands": {
    "allow": ["node", "npm", "npx"],
    "deny": ["powershell", "pwsh", "cmd", "bash", "sh"]
  },
  "env": {
    "allow": [
      "CYBORG_SHELL",
      "CYBORG_WORKSPACE_ROOT",
      "CYBORG_TOOL_REGISTRY",
      "CYBORG_SESSION_ID",
      "CYBORG_TOOL_RUNTIME_CWD",
      "CYBORG_TOOL_ISOLATED",
      "PATH",
      "NODE_ENV"
    ],
    "deny_patterns": [".*(API_KEY|TOKEN|PASSWORD|PRIVATE_KEY|SECRET)$"]
  },
  "workspace": {
    "cwd_must_be_inside_root": true,
    "filesystem_must_stay_inside_root": true,
    "read": ["."],
    "write": ["."]
  },
  "approvals": {
    "mode": "ask"
  }
}
```

Agent profiles can reference a policy:

```json
{
  "name": "researcher",
  "policy": "research-policy"
}
```

Commands:

```powershell
npm run cyborg -- policy add policies\research-policy.json
npm run cyborg -- policy list
npm run cyborg -- policy show research-policy
```

Approval commands:

```powershell
npm run cyborg -- approval list
npm run cyborg -- approval allow apr_...
npm run cyborg -- approval deny apr_...
```

Inside the interactive shell:

```text
/approvals
/allow apr_...
/deny apr_...
```

Current enforcement:

- subagent task names are checked against policy task allow/deny lists;
- subagent tool names are checked against policy tool allow/deny lists;
- tool invocations are checked against command allow/deny lists;
- invocation cwd must stay inside the Cyborg workspace by default;
- filesystem path checks support workspace-only read/write roots;
- environment variables passed to guarded invocations are allowlisted and secret-like names are stripped;
- allow/deny decisions during task execution are written to run history as `policy.allow` or `policy.deny`.
- `approvals.mode: "ask"` creates a pending approval instead of executing denied commands;
- `allow-once` approvals are bound to an invocation fingerprint and consumed after one use.

Security modes:

- `workspace`: default. Enforce command policy, env sanitization, cwd guard, and workspace filesystem path guard.
- `restricted`: reserved for a stricter future mode with explicit read/write/network scopes.
- `bypass-all`: trusted local debugging mode. Skips policy guards and passes env through. Do not use for untrusted tools, scheduled jobs, or shared machines.

The built-in `default` policy is intentionally conservative for command execution: Node package entrypoints are allowed, broad shell entrypoints are denied. Current sandboxing is a Cyborg guard layer, not an OS/container isolation boundary. Future work should add stronger process/container sandboxing before untrusted tools are supported.

The Agent loop becomes:

```text
scan tool registry
  -> run help for usage
  -> run manifest for contracts
  -> call the A2C2A endpoint
  -> repair from structured errors
```

This should make adding a CLI feel as easy as adding a skill, while avoiding stale skill docs. The executable owns the current help text and machine contracts.

See:

- [Cyborg Tool Standard](docs/cyborg-tool-standard.md)
- [Agent Framework Notes](docs/agent-framework-notes.md)
- [Small-Model Agent Architecture](docs/small-model-agent-architecture.md)
- [Agent Framework Survey](docs/framework-survey.md)

## Runtime Direction

The standard is language-neutral, but the first implementation is Node-first.

Tool registrations may declare:

```json
{
  "runtime": {
    "type": "node",
    "node": ">=20",
    "requires_cyborg_shell": true
  }
}
```

Python should be added later as a runtime backend, not as a redesign of the Agent architecture.

## Model Strategy

Cyborg-Agent is designed for two model profiles:

- `small`: low-cost default model for normal planning, tool selection, repair, and scheduled tasks.
- `large`: expensive fallback model for difficult planning, new tool creation, or repeated repair failure.

The default mode should be automatic routing:

```text
small model first
  -> repair with structured errors
  -> fallback to large model only when needed
  -> save successful workflow as code/config
```

This keeps recurring tasks cheap.

## Scheduler Direction

Scheduled tasks should be first-class, not an afterthought.

Example future workflow:

```powershell
npm run cyborg -- init
npm run cyborg -- task add examples\research-progress.daily.json
npm run cyborg -- task list
npm run cyborg -- task run research-progress
npm run cyborg -- task schedule --once
npm run cyborg -- task schedule --watch --interval 60000
npm run cyborg -- task history research-progress
```

The first reference task is `examples/research-progress.daily.json`. It runs a lightweight scheduled-report shape and generates an HTML report through Page-Generator-CLI.

## Testing

Before release, run the local checks:

```powershell
npm run typecheck
npm test
npm run build
```

The current test suite covers:

- config defaults and model routing;
- tool registration add/list/get/remove behavior;
- task config add/list/load validation;
- command invocation with stdin/env capture;
- task execution through a fake A2C2A tool with saved run history;
- CLI help and tool-management smoke tests.
- hook registration and lifecycle event execution;
- agent profile registration and constrained subagent runs.
- A2A message validation and subagent transcript generation.
- Markdown agent descriptor parsing and subagent lifecycle status snapshots.
- policy validation, command guardrails, environment sanitization, and workspace cwd checks.
- pending approvals, allow-once execution, and approval CLI/shell commands.

For cross-project smoke testing with Page-Generator-CLI:

```powershell
npm run cyborg -- context --json
npm run cyborg -- task run research-progress
npm run cyborg -- task history research-progress
```

## Error-Aware Loop

Cyborg-Agent should treat errors as part of the conversation, not as dead ends.

```text
Agent sends JSON -> code validates -> code returns error -> Agent fixes JSON/input/code -> retry
```

The most important distinction:

- `json_parse_error`: the Agent did not send valid JSON.
- `request_format_error`: the Agent did not follow the A2C2A envelope.
- `input_validation_error`: the Agent selected the right action but gave wrong data.
- `runtime_error`: the data passed validation, but the script itself failed or met bad runtime data.

This makes failures useful. They become feedback for the next Agent action.

## Roadmap

- Tool registry for local scripts and CLIs.
- A2C2A manifest discovery.
- Small-model-first planner.
- Two-model routing with large-model fallback.
- Scheduled task configs and run history.
- Agent planning loop with structured retries.
- Script creation and versioning workflow.
- Local-first execution mode.
- Integration examples with `Page-Generator-CLI`.

## Philosophy

Make Code Great Again does not mean rejecting LLMs. It means letting LLMs do what they are good at while preserving the computer world's strongest invention: executable, inspectable, reusable code.
