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

1. Add `runAgentGoalStream()` event generator. Done in the first TUI pass.
2. Build `src/tui/chat-app.tsx` using Ink and existing shell semantics. Done in the first TUI pass.
3. Make `cyborg chat` use Ink by default when TTY is available; keep `--plain` and piped input fallback. Done in the first TUI pass.
4. Add message rows and status line. First version done: user, system, command, tool, assistant, error rows plus session/model/token/approval/audit/subagent status.
5. Add richer live tool/subagent/scheduler event rendering.
6. Add token budget estimate and auto compact into memory.
7. Add session chooser.

## Architecture Lessons To Keep

Claude Code's strongest architectural idea is the event boundary: the agent loop emits state changes, and the UI is only a renderer of those changes. Cyborg should keep that boundary because it is what lets the same core loop support:

- `cyborg ask` batch execution;
- `cyborg chat` interactive TUI;
- scheduled task execution;
- subagent worker execution;
- future remote dashboards or logs.

The Cyborg-specific version should remain smaller:

- one structured planner step at a time;
- A2C2A JSON as the tool-call contract;
- compact context by default;
- small model first, large model only on configured fallback;
- saved run events as the source of truth.

## Safety Lessons To Keep

The useful pattern is not a single "safe mode"; it is a layered decision system.

- `allow / ask / deny` should remain the core vocabulary for policy decisions.
- plan mode should be read-only by default and only unlock write actions after approval.
- bypass-all should exist because real operators need it, but it must be explicit, visible, audited, and never silently enabled by config drift.
- workspace guard is a necessary minimum, but it is not an OS sandbox. Cyborg should describe it honestly.
- shell commands deserve stricter checks than A2C2A tools because shell behavior expands at runtime.
- every denial should feed back into the agent loop as a structured observation, so the small model can change strategy instead of retrying the same blocked action.

Near-term Cyborg work:

- render pending approval cards in the TUI;
- add one-key allow/deny actions;
- add a visible permission mode in the status line;
- add denial counters per session to stop repeated unsafe attempts;
- document the difference between workspace guard, policy approval, and future OS/container sandboxing.

## TUI Lessons To Keep

The TUI should communicate state, not decorate output. The important pieces are:

- top identity band: product, current session, compact purpose;
- scrollback rows with stable labels and restrained color;
- live planner/tool rows so the user sees why the agent is still running;
- bottom input row with clear busy/ready state;
- status line with model, routing, tokens, approvals, audit denies, and subagents;
- keyboard affordances that are discoverable through `/help`, not a wall of text on screen.

The current first pass intentionally avoids heavy features:

- no virtualized scrollback yet;
- no vim editing mode yet;
- no split-pane file diff yet;
- no terminal animation library beyond Ink primitives.

This keeps Cyborg npm-friendly and understandable while giving it a real persistent command-line presence.

## Current Follow-Up Backlog

The second TUI pass covers the most important pieces from the comparison:

- shared shell line classification for readline, TUI, shortcuts, and planner routing;
- recent chat history restoration in the Ink chat;
- pending approval card with allow-once/deny keyboard actions;
- permission mode, context pressure, approval, deny, token, and subagent visibility in the status line;
- rough context token pressure in `/session` and planner conversation payloads;
- stronger state evaluator stops for repeated actions, repeated error types, and no-progress context loops.

Still valuable later:

- command history navigation and slash-command completion;
- grouped/collapsible planner step rows;
- real model token streaming, once JSON repair stability is protected;
- automatic memory compaction when context pressure crosses the high threshold;
- explicit plan/read-only mode UI and approval flow;
- richer permission cards per scope, especially shell command/network/file write;
- session picker when `cyborg chat --resume` is called without a path.

## Memory Compaction Policy

Automatic memory should be conservative. Cyborg should not silently persist full chat transcripts when context pressure gets high. The safe default is:

- save only a short operational summary;
- mark it with `auto-compact`;
- store the source session id and compaction boundary;
- keep the newest turns in live context;
- make the saved memory visible in `/session` and normal memory commands.

This gives the small planner useful continuity without turning memory into an unbounded transcript archive.

## What Not To Borrow Yet

- Full virtualized scrollback.
- Vim input mode.
- Worktree isolation.
- Prompt cache engineering.
- Multi-provider streaming adapters.
- Heavy feature-flag system.

Those are valuable later, but Cyborg's core promise is small, cheap, inspectable automation.
