# Agent Framework Notes

Status: v0.1 implementation notes

The Agent framework builds on the tool registry rather than bypassing it.

## Core Idea

Cyborg-Agent is not just an LLM wrapper. It is a runtime that lets the Agent discover, call, repair, and evolve deterministic tools.

The framework separates:

- planning and reasoning;
- tool discovery;
- tool invocation;
- A2C2A repair loop;
- durable code/tool creation;
- audit and session state.

## Proposed Layers

```text
User request
  -> Agent planner
  -> Tool discovery
  -> Tool selection
  -> A2C2A request builder
  -> Cyborg tool runner
  -> structured result/error
  -> repair or final answer
```

## Main Modules

Current core modules:

```text
src/
  cli/
    index.ts              # cyborg commands
  registry.ts             # .cyborg/tools management
  runner.ts               # controlled command execution
  tool-runtime.ts         # runtime cwd, env, install, doctor
  doctor.ts               # whole-workspace diagnostics
  hooks.ts                # lifecycle event hooks
  agents.ts               # agent profiles and subagent runs
  a2a.ts                  # parent/subagent transcript
  policy.ts               # permission policy and workspace guards
  approvals.ts            # allow-once approval queue
  agent/
    tool-context.ts       # collect help + manifest for relevant tools
    task-runner.ts        # deterministic task execution through A2C2A
    shell.ts              # persistent command shell
```

## Node-First Runtime

The first implementation supports Node tools only.

Reasons:

- Page-Generator-CLI is Node-first;
- frontend-oriented tools fit Node well;
- local process execution is already implemented;
- this keeps v0.1 small enough to finish.

The standard should still keep `runtime.type` language-neutral so Python can be added later.

## Future Python Backend

Python should be added as a runtime backend, not as a parallel Agent architecture.

Future shape:

```text
Cyborg runner
  -> runtime.type=node    -> Node runner
  -> runtime.type=python  -> Python runner
  -> runtime.type=service -> HTTP/service runner
```

If Python runtime appears before implementation, Cyborg-Agent should return `runtime_not_supported`.

## Cyborg Shell

The Agent framework should provide:

```powershell
cyborg shell
```

The shell sets:

```text
CYBORG_SHELL=1
CYBORG_WORKSPACE_ROOT=<workspace>
CYBORG_TOOL_REGISTRY=<workspace>/.cyborg/tools
CYBORG_SESSION_ID=<id>
```

The shell is a protocol environment, not a full OS sandbox. The current implementation includes:

- workspace path enforcement;
- permission policies;
- audit logs;
- command allowlists;
- approval queue;
- isolated Node tool runtimes.

Still missing:

- OS/container sandboxing for untrusted tools;
- network permissions;
- complete artifact tracking.

## Tool Use Policy

The Agent should prefer this order:

1. Use an existing registered tool.
2. If the tool input is invalid, repair the A2C2A request.
3. If the tool is missing a capability, decide whether to extend the tool.
4. If no tool exists, create a new tool and register it.

This keeps repeatable work in code and keeps model reasoning focused on novel work.

## First Agent Loop Target

The first concrete loop can be:

```text
User asks for a page
  -> Agent discovers page-generator-cli
  -> Agent runs help + manifest
  -> Agent builds page.render A2C2A request
  -> cyborg tool call page-generator-cli
  -> Agent repairs validation errors if needed
  -> Agent returns artifact path and summary
```

This makes Page-Generator-CLI the first end-to-end proof of Cyborg-Agent.
