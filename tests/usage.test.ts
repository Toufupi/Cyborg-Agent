import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { summarizeUsage } from "../src/usage.js";
import { withTempWorkspace } from "./helpers.js";

describe("usage summaries", () => {
  it("summarizes token usage from agent runs", async () => {
    await withTempWorkspace(async (root) => {
      const runDir = path.join(root, ".cyborg", "runs", "agent-demo");
      await mkdir(runDir, { recursive: true });
      await writeFile(path.join(runDir, "run.json"), JSON.stringify({
        id: "agent-demo",
        root,
        events: [
          {
            type: "agent.model",
            data: {
              model: "small",
              role: "small",
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
            }
          },
          {
            type: "agent.model",
            data: {
              model: "large",
              role: "large",
              usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
            }
          }
        ]
      }), "utf8");

      const summary = await summarizeUsage(root);

      expect(summary.runs).toBe(1);
      expect(summary.model_calls).toBe(2);
      expect(summary.small.total_tokens).toBe(15);
      expect(summary.large.total_tokens).toBe(30);
      expect(summary.by_model.small.calls).toBe(1);
    });
  });
});
