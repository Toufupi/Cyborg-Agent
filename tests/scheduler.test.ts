import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isDue, runDueTasks } from "../src/scheduler.js";
import { addTask } from "../src/task.js";
import { addTool } from "../src/registry.js";
import { fakeToolRegistration, withTempWorkspace, writeJson } from "./helpers.js";

describe("scheduler", () => {
  it("evaluates simple schedules", () => {
    expect(isDue("@once", undefined)).toBe(true);
    expect(isDue("@once", new Date().toISOString())).toBe(false);
    expect(isDue("every 1 second", new Date(Date.now() - 2000).toISOString())).toBe(true);
  });

  it("runs due tasks once and records state", async () => {
    await withTempWorkspace(async (root) => {
      const script = path.join(root, "tool.mjs");
      await writeFile(script, "process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ ok: true, result: {} })));", "utf8");
      await addTool(await writeJson(root, "tool.json", fakeToolRegistration({
        name: "scheduled-tool",
        discovery: { strategy: "static", a2c2a: { command: process.execPath, args: [script] } }
      })), root);
      await addTask(await writeJson(root, "task.json", {
        name: "scheduled-task",
        schedule: "@once",
        goal: "Run once.",
        steps: [{ name: "step", tool: "scheduled-tool", action: "run", input: {} }]
      }), root);

      const first = await runDueTasks(root);
      const second = await runDueTasks(root);

      expect(first.runs).toHaveLength(1);
      expect(second.runs).toHaveLength(0);
    });
  });
});
