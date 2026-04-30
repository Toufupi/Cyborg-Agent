import { describe, expect, it } from "vitest";
import { runPlannerEval } from "../src/evals/planner-eval.js";
import type { ModelClient } from "../src/model-client.js";
import { withTempWorkspace, writeJson } from "./helpers.js";

describe("planner evals", () => {
  it("runs offline eval cases against expected plans", async () => {
    const report = await runPlannerEval(process.cwd(), { dir: "evals/planner" });

    expect(report.ok).toBe(true);
    expect(report.cases).toBeGreaterThanOrEqual(3);
    expect(report.metrics.expected_kind_rate).toBe(1);
    expect(report.usage.baseline_prompt_tokens_estimate).toBeGreaterThan(0);
  });

  it("can evaluate a live model client and summarize token savings", async () => {
    await withTempWorkspace(async (root) => {
      await writeJson(root, "case.json", {
        schema: "cyborg.planner-eval.v0.1",
        name: "fake-live",
        goal: "run report",
        context: {
          tasks: [{ name: "daily-report" }],
          tools: [],
          expected_plan: { kind: "final", message: "wrong" }
        },
        expect: {
          kind: "run_task",
          task: "daily-report"
        },
        baseline: {
          prompt_tokens_estimate: 1000
        }
      });
      const modelClient: ModelClient & {
        completeJsonWithUsage: ModelClient["completeJson"];
      } = {
        async completeJson() {
          return { kind: "run_task", task: "daily-report", confidence: 0.9 };
        },
        async completeJsonWithUsage() {
          return {
            json: { kind: "run_task", task: "daily-report", confidence: 0.9 },
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }
          };
        }
      };

      const report = await runPlannerEval(root, { dir: root, live: true, modelClient });

      expect(report.ok).toBe(true);
      expect(report.usage.calls).toBe(1);
      expect(report.usage.prompt_tokens).toBe(100);
      expect(report.usage.estimated_prompt_tokens_saved).toBe(900);
      expect(report.usage.estimated_prompt_saving_rate).toBe(0.9);
    });
  });
});
