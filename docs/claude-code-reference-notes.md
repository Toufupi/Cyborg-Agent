# Claude Code Reference Notes

These notes summarize what Cyborg-Agent should borrow from the local `claude-code` reference repository without copying its implementation.

## What Matters Most

Claude Code's interactive feel is not just a prompt loop. It is a layered event UI:

- a persistent REPL rendered with Ink;
- a message list with user, assistant, tool, progress, error, and system rows;
- a status line showing model, session, cwd, permission mode, cost, tokens, and context pressure;
- streaming assistant text;
- tool-use cards that move from pending to success/error;
- session resume that restores not only messages but also cwd/worktree/context;
- context compaction and token budget management before API calls;
- a clear agentic loop state machine with a `transition` reason for every continuation.

Cyborg should adopt the shape, not the weight.

## Direct Mapping To Cyborg

### 1. Ink Chat REPL

Current Cyborg chat uses `readline`. That is fine for deterministic commands, but it cannot easily support Claude Code-style display.

Target:

- keep `executeShellLine()` as the command/planner engine;
- add an Ink `ChatApp` for interactive mode;
- render scrollback messages from the current `chat-*` session;
- keep slash commands deterministic;
- send normal text to planner with compact session context.

### 2. Event Stream Boundary

Claude Code's `query()` is an `AsyncGenerator`. Cyborg's planner currently returns only a final result.

Target:

- add `runAgentGoalStream()` as an async generator;
- yield events such as `planner.start`, `planner.step`, `tool.call`, `tool.result`, `repair.start`, `model.usage`, `agent.final`;
- keep `runAgentGoal()` as a wrapper that consumes the stream and returns the current result shape.

This gives the TUI live updates without changing tool semantics.

### 3. Message Rows

Minimum message row types for Cyborg:

- `user`: user input;
- `assistant`: final answer or planner explanation;
- `command`: deterministic slash command output;
- `tool`: A2C2A tool call status;
- `subagent`: A2A delegate/progress/result;
- `scheduler`: daemon/task status;
- `system`: errors, resume, compaction, model fallback.

### 4. Status Line

Minimum Cyborg status line:

- session id and resumed/new marker;
- small/large model;
- routing mode;
- tool count and task count;
- model token totals;
- audit deny/failure count;
- pending approvals count;
- scheduler daemon status;
- subagent live/stale count.

### 5. Token Budget And Compaction

Cyborg already sends bounded recent chat context. Next step is making this explicit:

- rough token estimate for context payload;
- warning threshold;
- compact old chat into `memory` when the shell grows;
- keep newest turns verbatim;
- include compaction boundary in `/session`.

### 6. Session Resume

Already implemented:

- `cyborg chat --continue`;
- `cyborg chat --resume <run>`;
- compact recent chat context passed to planner.

Next:

- session chooser when `--resume` has no value;
- preview list with session id, title, time, last user message;
- restore cwd if the resumed session recorded one.

### 7. Permission And Approval UX

Cyborg already has approvals, policy, and audit logs.

Next:

- show pending approvals in the status line;
- render approval cards in the Ink chat;
- support one-key allow/deny in the TUI.

## Suggested Implementation Order

1. Add `runAgentGoalStream()` event generator.
2. Build `src/tui/chat-app.tsx` using Ink and existing `executeShellLine()`.
3. Make `cyborg chat` use Ink by default when TTY is available; keep readline fallback for pipes and simple terminals.
4. Add message rows and status line.
5. Add live tool/subagent/scheduler event rendering.
6. Add token budget estimate and auto compact into memory.
7. Add session chooser.

## What Not To Borrow Yet

- Full virtualized scrollback.
- Vim input mode.
- Worktree isolation.
- Prompt cache engineering.
- Multi-provider streaming adapters.
- Heavy feature-flag system.

Those are valuable later, but Cyborg's core promise is small, cheap, inspectable automation.
