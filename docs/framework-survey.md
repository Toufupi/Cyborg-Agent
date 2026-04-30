# Agent Framework Survey

Status: notes for Cyborg-Agent design

## Core Position

Cyborg-Agent is not trying to become another large-context autonomous coding agent.

Many existing agents work by loading huge prompts, tool descriptions, memory, repo context, and workflow instructions into one conversation. That can be powerful, but it pushes the system toward large and expensive models.

Cyborg-Agent should go the other way:

- small-model friendly;
- low context usage;
- code as durable knowledge;
- self-describing tools instead of huge prompt skills;
- scheduled and recurring tasks as a first-class use case;
- large models used only when needed.

The target user should be able to run useful personal agents cheaply, for example:

- daily news collection;
- weekly research progress tracking;
- paper monitoring;
- GitHub release watching;
- generated reports;
- periodic web checks;
- lightweight personal automation.

## Do Not Use Leaked Source

We should not copy or rely on leaked Claude Code source or any other leaked proprietary code.

Allowed:

- learn from public docs;
- borrow public product concepts;
- implement our own architecture;
- use open-source frameworks under their licenses.

Not allowed:

- copying leaked implementation;
- depending on non-public behavior;
- treating leaked code as architecture source of truth.

Public Claude Code concepts worth studying:

- subagents;
- hooks;
- memory files;
- slash-command-like workflows;
- tool permission model.

These are product patterns, not code to copy.

## Existing Frameworks

### Claude Code

Useful ideas:

- subagents with focused responsibilities;
- hooks around tool use;
- project memory;
- command workflows;
- permission boundaries.

Cyborg-Agent adaptation:

- subagents can become small model roles with constrained tool context;
- hooks can become lifecycle events around scheduled tasks and tool calls;
- memory should be structured files and code, not a giant prompt.

### OpenAI Agents SDK

Useful ideas:

- tools;
- handoffs;
- guardrails;
- tracing.

Cyborg-Agent adaptation:

- keep tool calls behind Cyborg Tool Standard;
- add tracing/audit logs around `cyborg tool call`;
- treat handoff as model/router escalation or task delegation.

### LangGraph

Useful ideas:

- graph-based durable execution;
- explicit state;
- human-in-the-loop;
- retries.

Cyborg-Agent adaptation:

- scheduled jobs and recurring tasks should be state machines;
- repair loops should be explicit nodes;
- store state outside model context.

### PydanticAI

Useful ideas:

- schema-first agent IO;
- typed tools;
- structured output validation;
- retry on validation failure.

Cyborg-Agent adaptation:

- good future fit for Python backend;
- not the v0.1 core because we are Node-first;
- keep the standard language-neutral so Python runtime can be added later.

### CrewAI / AutoGen

Useful ideas:

- role-based multi-agent patterns;
- task delegation;
- group workflows.

Cyborg-Agent adaptation:

- do not start with a multi-agent swarm;
- start with one small model planner plus tool registry;
- add specialist agents only when a recurring workflow needs them.

### MCP

Useful ideas:

- standard tool/resource discovery;
- ecosystem bridge.

Cyborg-Agent adaptation:

- MCP can be an adapter later;
- A2C2A remains the repairable Agent-to-code protocol;
- Cyborg Tool Standard remains local CLI registration and runtime policy.

## Decision

Do not adopt a full external agent framework as the core for v0.1.

Build a small TypeScript core:

```text
registry
  -> tool discovery
runner
  -> controlled execution
agent planner
  -> small model reasoning
request builder
  -> A2C2A JSON
repair loop
  -> structured retries
scheduler
  -> recurring jobs
model router
  -> small/large model selection
```

External frameworks may become adapters:

- OpenAI Agents SDK adapter;
- LangGraph-style workflow adapter;
- PydanticAI Python runtime adapter;
- MCP bridge.

## Why This Matters

The design goal is not maximum intelligence per single request. It is maximum useful automation per dollar and per token.

Small models should be able to drive the system because:

- tool discovery is compact;
- code holds procedural knowledge;
- manifests replace long prompt instructions;
- scheduled tasks reuse known workflows;
- large models are fallback, not the default.
