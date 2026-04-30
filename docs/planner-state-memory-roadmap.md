# Planner, State, And Memory Roadmap

Status: design notes for the next Cyborg-Agent iterations.

## Planner Shape

Cyborg uses bounded ReAct with structured JSON actions, not free-form chain-of-thought.

The loop is:

```text
goal
  -> compact context
  -> one JSON planner step
  -> deterministic execution
  -> structured observation
  -> state evaluation
  -> continue | final | stop
```

The model should not emit long hidden reasoning. It should emit one small action object with a short `reason`.

## State Evaluator

Stopping should not depend only on model vibes.

The first evaluator should be rule-based and inspect:

- explicit `answer` or `final`;
- successful `run_task`;
- successful artifact-producing tool responses;
- unresolved tool/runtime/model errors;
- repeated actions;
- max steps;
- repair attempts;
- timeout/cancel state.

Future evaluator output should stay structured:

```json
{
  "decision": "continue",
  "reason": "tool produced an observation but no final answer yet",
  "metrics": {
    "steps": 2,
    "errors": 0,
    "artifacts": 1
  }
}
```

## Prompt Discipline

The core prompt is intentionally small:

- return exactly one JSON object;
- choose one known step kind;
- inspect manifests before unclear tool calls;
- prefer registered tasks for recurring goals;
- create tools only when no registered capability fits;
- use only listed tools and tasks.

This is tested for functionality, but not yet benchmarked as prompt quality. We should add planner evals with fixed goals, expected next steps, and small/large model comparisons.

## Persistent Memory

Cyborg needs memory, but it should not become a large chat-history dump.

Start with file-backed structured memory:

```text
.cyborg/memory/
  facts/
  procedures/
  tool-learnings/
  failures/
  artifacts/
```

Memory should be retrieved selectively by tags, task names, tool names, and goal keywords. Only a small relevant slice should enter planner context.

Useful first memory types:

- `run_memory`: recent success/failure summaries;
- `tool_memory`: correct CLI usage and common errors;
- `procedure_memory`: reusable task patterns;
- `preference_memory`: user/project preferences;
- `error_memory`: A2C2A repair examples and failure fixes.

The research/news task is only a demo. The general pattern is: install a CLI, register its A2C2A contract, and let Cyborg provide planning, scheduling, policy, repair, subagent lifecycle, A2A, audit, and memory.
