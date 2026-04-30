import { describe, expect, it } from "vitest";
import { evaluateAgentState } from "../src/agent/state-evaluator.js";

describe("agent state evaluator", () => {
  it("finalizes when a step reports done", () => {
    const evaluation = evaluateAgentState({
      step: 0,
      plan: { kind: "run_task", task: "demo", confidence: 0.9, reason: "registered task" },
      result: {
        ok: true,
        done: true,
        output: "done",
        observation: { run: ".cyborg/runs/demo/run.json" }
      },
      observations: []
    });

    expect(evaluation.decision).toBe("final");
    expect(evaluation.metrics.artifacts).toBe(1);
  });

  it("stops repeated equivalent actions", () => {
    const plan = {
      kind: "inspect_context" as const,
      reason: "still checking"
    };
    const evaluation = evaluateAgentState({
      step: 2,
      plan,
      result: {
        ok: true,
        done: false,
        output: "",
        observation: { tools: [] }
      },
      observations: [
        { action: plan, observation: { tools: [] } },
        { action: plan, observation: { tools: [] } }
      ]
    });

    expect(evaluation.decision).toBe("stop");
    expect(evaluation.reason).toContain("repeated");
  });
});
