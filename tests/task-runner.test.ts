import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runTask } from "../src/agent/task-runner.js";
import { addTool } from "../src/registry.js";
import { addTask } from "../src/task.js";
import { fakeToolRegistration, withTempWorkspace, writeJson } from "./helpers.js";

describe("task runner", () => {
  it("runs a task through an A2C2A tool and records structured history", async () => {
    await withTempWorkspace(async (root) => {
      const scriptPath = path.join(root, "fake-a2c2a-tool.mjs");
      await writeFile(scriptPath, [
        "let raw = '';",
        "process.stdin.on('data', chunk => { raw += chunk; });",
        "process.stdin.on('end', () => {",
        "  const request = JSON.parse(raw);",
        "  console.log(JSON.stringify({ ok: true, action: request.action, title: request.input.title, shell: process.env.CYBORG_SHELL }));",
        "});"
      ].join("\n"), "utf8");

      const toolFile = await writeJson(root, "tool.json", fakeToolRegistration({
        name: "report-tool",
        discovery: {
          strategy: "static",
          a2c2a: {
            command: process.execPath,
            args: [scriptPath]
          }
        }
      }));
      await addTool(toolFile, root);

      const taskFile = await writeJson(root, "task.json", {
        name: "daily-report",
        goal: "Render a daily report.",
        steps: [{
          name: "render",
          tool: "report-tool",
          action: "render",
          input: {
            title: "Daily Research"
          }
        }]
      });
      await addTask(taskFile, root);

      const result = await runTask("daily-report", root);
      const run = JSON.parse(await readFile(result.file, "utf8")) as {
        events: Array<{ type: string; data?: { stdout?: string } }>;
      };

      expect(run.events.map((event) => event.type)).toEqual([
        "task.start",
        "step.start",
        "step.ok",
        "task.end"
      ]);

      const stepOk = run.events.find((event) => event.type === "step.ok");
      expect(stepOk?.data?.stdout).toContain("\"action\":\"render\"");
      expect(stepOk?.data?.stdout).toContain("\"title\":\"Daily Research\"");
      expect(stepOk?.data?.stdout).toContain("\"shell\":\"1\"");
      expect(path.dirname(result.file)).toContain(path.join(root, ".cyborg", "runs"));
    });
  });

  it("records a failed step without aborting the whole task run", async () => {
    await withTempWorkspace(async (root) => {
      await mkdir(root, { recursive: true });
      const toolFile = await writeJson(root, "failing-tool.json", fakeToolRegistration({
        name: "failing-tool",
        discovery: {
          strategy: "static",
          a2c2a: {
            command: process.execPath,
            args: ["-e", "console.error('boom'); process.exit(7)"]
          }
        }
      }));
      await addTool(toolFile, root);

      const taskFile = await writeJson(root, "failing-task.json", {
        name: "failing-task",
        goal: "Show runtime errors in history.",
        steps: [{
          name: "explode",
          tool: "failing-tool",
          action: "render",
          input: {}
        }]
      });
      await addTask(taskFile, root);

      const result = await runTask("failing-task", root);
      const run = JSON.parse(await readFile(result.file, "utf8")) as {
        events: Array<{ type: string; data?: { code?: number; stderr?: string } }>;
      };
      const failed = run.events.find((event) => event.type === "step.failed");

      expect(failed?.data?.code).toBe(7);
      expect(failed?.data?.stderr).toContain("boom");
      expect(run.events.at(-1)?.type).toBe("task.end");
    });
  });

  it("passes the previous A2C2A result into the next step", async () => {
    await withTempWorkspace(async (root) => {
      const scriptPath = path.join(root, "chain-tool.mjs");
      await writeFile(scriptPath, [
        "let raw = '';",
        "process.stdin.on('data', chunk => { raw += chunk; });",
        "process.stdin.on('end', () => {",
        "  const request = JSON.parse(raw);",
        "  if (request.action === 'first') console.log(JSON.stringify({ ok: true, result: { title: 'From first' } }));",
        "  else console.log(JSON.stringify({ ok: true, result: { received: request.input.title } }));",
        "});"
      ].join("\n"), "utf8");
      const toolFile = await writeJson(root, "tool.json", fakeToolRegistration({
        name: "chain-tool",
        discovery: {
          strategy: "static",
          a2c2a: { command: process.execPath, args: [scriptPath] }
        }
      }));
      await addTool(toolFile, root);
      const taskFile = await writeJson(root, "task.json", {
        name: "chain-task",
        goal: "Chain step results.",
        steps: [
          { name: "first", tool: "chain-tool", action: "first", input: {} },
          { name: "second", tool: "chain-tool", action: "second", inputFromPrevious: true, input: {} }
        ]
      });
      await addTask(taskFile, root);

      const result = await runTask("chain-task", root);
      const run = JSON.parse(await readFile(result.file, "utf8")) as {
        events: Array<{ type: string; data?: { stdout?: string } }>;
      };

      expect(run.events.filter((event) => event.type === "step.ok").at(-1)?.data?.stdout).toContain("From first");
    });
  });
});
