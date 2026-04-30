import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentGoal } from "../src/agent/planner.js";
import type { ModelClient } from "../src/model-client.js";
import { addTool } from "../src/registry.js";
import { addTask } from "../src/task.js";
import type { JsonValue } from "../src/types.js";
import { fakeToolRegistration, withTempWorkspace, writeJson } from "./helpers.js";

class FakeModelClient implements ModelClient {
  calls = 0;

  constructor(private readonly responses: JsonValue[]) {}

  async completeJson() {
    const response = this.responses[this.calls];
    this.calls += 1;
    if (response === undefined) {
      throw new Error("No fake model response configured.");
    }
    return response;
  }
}

describe("agent planner loop", () => {
  it("uses a model plan to run an existing task", async () => {
    await withTempWorkspace(async (root) => {
      const scriptPath = path.join(root, "tool.mjs");
      await writeFile(scriptPath, [
        "process.stdin.resume();",
        "process.stdin.on('end', () => console.log(JSON.stringify({ ok: true })));"
      ].join("\n"), "utf8");
      const toolFile = await writeJson(root, "tool.json", fakeToolRegistration({
        name: "report-tool",
        discovery: {
          strategy: "static",
          a2c2a: { command: process.execPath, args: [scriptPath] }
        }
      }));
      await addTool(toolFile, root);
      const taskFile = await writeJson(root, "task.json", {
        name: "daily-report",
        goal: "Render a daily report.",
        steps: [{ name: "render", tool: "report-tool", action: "report.render", input: {} }]
      });
      await addTask(taskFile, root);

      const modelClient = new FakeModelClient([
        { kind: "run_task", task: "daily-report", confidence: 0.9, reason: "registered recurring task" }
      ]);

      const result = await runAgentGoal("make the daily report", root, { modelClient });
      const run = JSON.parse(await readFile(result.file, "utf8")) as { events: Array<{ type: string }> };

      expect(result.output).toContain("\"ok\": true");
      expect(result.plan.kind).toBe("run_task");
      expect(run.events.some((event) => event.type === "agent.plan")).toBe(true);
      expect(modelClient.calls).toBe(1);
    });
  });

  it("repairs an A2C2A tool request after structured validation errors", async () => {
    await withTempWorkspace(async (root) => {
      const scriptPath = path.join(root, "repair-tool.mjs");
      await writeFile(scriptPath, [
        "let raw = '';",
        "process.stdin.on('data', chunk => { raw += chunk; });",
        "process.stdin.on('end', () => {",
        "  const request = JSON.parse(raw);",
        "  if (!request.input.title) {",
        "    console.log(JSON.stringify({ ok: false, error: { type: 'input_validation_error', details: { issues: [{ path: '$.input.title', code: 'missing_required' }] } } }));",
        "    process.exit(1);",
        "  }",
        "  console.log(JSON.stringify({ ok: true, result: { title: request.input.title } }));",
        "});"
      ].join("\n"), "utf8");
      const toolFile = await writeJson(root, "tool.json", fakeToolRegistration({
        name: "page-tool",
        discovery: {
          strategy: "static",
          a2c2a: { command: process.execPath, args: [scriptPath] }
        }
      }));
      await addTool(toolFile, root);

      const modelClient = new FakeModelClient([
        {
          kind: "call_tool",
          tool: "page-tool",
          request: { a2c2a: "0.1", action: "page.render", input: {} },
          confidence: 0.8,
          reason: "page tool can render"
        },
        {
          kind: "call_tool",
          tool: "page-tool",
          request: { a2c2a: "0.1", action: "page.render", input: { title: "Fixed" } },
          confidence: 0.9,
          reason: "fixed missing title"
        }
      ]);

      const result = await runAgentGoal("render a page", root, { modelClient, maxRepairAttempts: 1 });
      const run = JSON.parse(await readFile(result.file, "utf8")) as { events: Array<{ type: string }> };

      expect(result.output).toContain("\"ok\":true");
      expect(result.output).toContain("\"Fixed\"");
      expect(run.events.some((event) => event.type === "agent.repair_plan")).toBe(true);
      expect(modelClient.calls).toBe(2);
    });
  });
});
