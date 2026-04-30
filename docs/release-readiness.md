# Release Readiness

This document tracks whether Cyborg-Agent is ready for an early public v0.1/v0.2 style release.

## Current Position

Cyborg-Agent is now a real lightweight agent runtime, not just a task runner.

It can:

- open a persistent CLI shell with deterministic slash commands;
- accept natural language goals through a small-model JSON planner;
- inspect compact tool/task context instead of loading giant prompt packs;
- call registered A2C2A tools;
- repair structured A2C2A errors;
- fallback to a large model when routing policy says the small model is stuck;
- record model token usage by small/large model;
- evaluate planner behavior against fixed cases and live model calls;
- create reusable Node A2C2A tools through the built-in tool-builder subagent;
- run constrained subagents with A2A transcript, status, timeout, cancellation, progress, and run listing;
- run scheduled tasks with daemon status and stop requests;
- enforce lightweight policy guardrails and pending approvals;
- write audit logs and audit summaries;
- extract reusable memories from structured agent run errors;
- install local tool registrations through a marketplace index;
- show a lightweight Ink TUI overview.

## Smoke Commands

```powershell
npm run typecheck
npm test
npm run build
npm run cyborg -- doctor
npm run cyborg -- model --smoke
npm run cyborg -- eval planner
npm run cyborg -- usage
npm run cyborg -- audit summary
npm run cyborg -- agent runs --all
npm run cyborg -- task schedule --status
```

With a configured model:

```powershell
npm run cyborg -- ask "run the research progress report"
npm run cyborg -- eval planner --live --output .cyborg\evals\planner-live.json
```

## Publish Checklist

- Verify `.cyborg/`, `dist/`, `node_modules/`, and generated reports are ignored.
- Run the smoke commands above.
- Confirm README examples match the current CLI help.
- Confirm no local API keys are committed.
- Tag the release only after a clean `git status`.

## Known Boundaries

- The sandbox is a Cyborg policy guard, not an OS/container sandbox.
- Marketplace remote URLs are intentionally rejected for now; local indexes are supported.
- Python tool runtime is still a future backend.
- The planner eval baseline token numbers are estimates until compared against real historical workflows.
- The TUI is a lightweight overview, not yet a full Claude Code-style interface.

## Next High-Value Iterations

- Add real background daemon start support that detaches from the terminal.
- Add a richer live eval suite and record model outputs over time.
- Add remote marketplace fetch with signature/checksum metadata.
- Add network policy enforcement for built-in fetch tools.
- Add a more interactive TUI for approvals, subagent runs, and scheduler status.
