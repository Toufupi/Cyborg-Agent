import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isDue, loadSchedulerState, runDueTasks, watchDueTasks } from "../src/scheduler.js";
import { addTask } from "../src/task.js";
import { addTool } from "../src/registry.js";
import { readAuditEvents } from "../src/audit.js";
import { fakeToolRegistration, withTempWorkspace, writeJson } from "./helpers.js";

describe("scheduler", () => {
  it("evaluates simple schedules", () => {
    expect(isDue("@once", undefined)).toBe(true);
    expect(isDue("@once", new Date().toISOString())).toBe(false);
    expect(isDue("every 1 second", new Date(Date.now() - 2000).toISOString())).toBe(true);
    expect(isDue("0 8 * * *", undefined, new Date("2026-04-30T08:00:00"))).toBe(true);
    expect(isDue("0 8 * * *", undefined, new Date("2026-04-30T08:01:00"))).toBe(false);
    expect(isDue("*/5 * * * *", undefined, new Date("2026-04-30T08:10:00"))).toBe(true);
    expect(isDue("*/5 * * * *", undefined, new Date("2026-04-30T08:11:00"))).toBe(false);
    expect(isDue("0 8 * * *", new Date("2026-04-30T08:00:20").toISOString(), new Date("2026-04-30T08:00:50"))).toBe(false);
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
      expect(first.errors).toHaveLength(0);
      expect(second.runs).toHaveLength(0);
      expect((await readAuditEvents(root)).map((event) => event.type)).toContain("scheduler.task.end");
    });
  });

  it("records failed task steps and keeps scheduler state", async () => {
    await withTempWorkspace(async (root) => {
      await addTool(await writeJson(root, "tool.json", fakeToolRegistration({
        name: "broken-tool",
        discovery: {
          strategy: "static",
          a2c2a: {
            command: process.execPath,
            args: ["-e", "throw new Error('broken')"]
          }
        }
      })), root);
      await addTask(await writeJson(root, "task.json", {
        name: "broken-task",
        schedule: "@once",
        goal: "Break once.",
        steps: [{ name: "break", tool: "broken-tool", action: "run", input: {} }]
      }), root);

      const result = await runDueTasks(root);
      const state = await loadSchedulerState(root);

      expect(result.runs).toHaveLength(1);
      expect(result.errors).toEqual([{ task: "broken-task", error: expect.stringContaining("broken") }]);
      expect(state.tasks["broken-task"]?.last_run).toBeTruthy();
      expect(state.tasks["broken-task"]?.last_error).toContain("broken");
      expect((await readAuditEvents(root)).map((event) => event.type)).toContain("scheduler.task.error");
    });
  });

  it("writes daemon state while watching scheduled tasks", async () => {
    await withTempWorkspace(async (root) => {
      const controller = new AbortController();
      let ticks = 0;
      await watchDueTasks(root, 10, controller.signal, () => {
        ticks += 1;
        if (ticks >= 2) {
          controller.abort();
        }
      });

      const state = await loadSchedulerState(root);
      const events = await readAuditEvents(root);

      expect(state.daemon?.status).toBe("stopped");
      expect(state.daemon?.last_tick_at).toBeTruthy();
      expect(events.map((event) => event.type)).toContain("scheduler.daemon.start");
      expect(events.map((event) => event.type)).toContain("scheduler.daemon.stop");
    });
  });
});
