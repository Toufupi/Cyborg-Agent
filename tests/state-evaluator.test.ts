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

  it("stops after repeated equivalent error types", () => {
    const evaluation = evaluateAgentState({
      step: 2,
      plan: {
        kind: "call_tool",
        tool: "page",
        request: { a2c2a: "0.1", action: "page.render", input: {} },
        confidence: 0.5,
        reason: "retry"
      },
      result: {
        ok: false,
        done: false,
        output: "bad input",
        error_type: "input_validation_error",
        observation: { ok: false, error: { type: "input_validation_error" } }
      },
      observations: [
        { action: { kind: "call_tool", tool: "page", request: { action: "page.render" } }, observation: { ok: false, error: { type: "input_validation_error" } } },
        { action: { kind: "inspect_tool", tool: "page" }, observation: { ok: false, error: { type: "input_validation_error" } } }
      ]
    });

    expect(evaluation.decision).toBe("stop");
    expect(evaluation.metrics.repeated_error_types).toBe(2);
  });
});
