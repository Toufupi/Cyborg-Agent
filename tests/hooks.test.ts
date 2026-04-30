import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runTask } from "../src/agent/task-runner.js";
import { addHook, listHooks, loadHook } from "../src/hooks.js";
import { addTool } from "../src/registry.js";
import { addTask } from "../src/task.js";
import { fakeToolRegistration, withTempWorkspace, writeJson } from "./helpers.js";

describe("hooks", () => {
  it("registers hooks and runs matching lifecycle events", async () => {
    await withTempWorkspace(async (root) => {
      await mkdir(path.join(root, "logs"), { recursive: true });
      const hookScript = path.join(root, "hook.mjs");
      const hookLog = path.join(root, "logs", "hook-events.jsonl");
      await writeFile(hookScript, [
        "import { appendFileSync } from 'node:fs';",
        "let raw = '';",
        "process.stdin.on('data', chunk => { raw += chunk; });",
        "process.stdin.on('end', () => {",
        `  appendFileSync(${JSON.stringify(hookLog)}, raw.trim() + '\\n');`,
        "});"
      ].join("\n"), "utf8");

      const hookFile = await writeJson(root, "hook.json", {
        schema: "cyborg.hook.v0.1",
        name: "capture-steps",
        events: ["step.ok"],
        invocation: {
          command: process.execPath,
          args: [hookScript]
        }
      });
      await addHook(hookFile, root);

      const toolScript = path.join(root, "tool.mjs");
      await writeFile(toolScript, "process.stdin.resume(); process.stdin.on('end', () => console.log('done'));", "utf8");
      const toolFile = await writeJson(root, "tool.json", fakeToolRegistration({
        name: "hooked-tool",
        discovery: {
          strategy: "static",
          a2c2a: {
            command: process.execPath,
            args: [toolScript]
          }
        }
      }));
      await addTool(toolFile, root);
      const taskFile = await writeJson(root, "task.json", {
        name: "hooked-task",
        goal: "Trigger hook.",
        steps: [{
          name: "render",
          tool: "hooked-tool",
          action: "render",
          input: {}
        }]
      });
      await addTask(taskFile, root);

      const result = await runTask("hooked-task", root);
      const run = JSON.parse(await readFile(result.file, "utf8")) as { events: Array<{ type: string }> };
      const log = (await readFile(hookLog, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as { event: string });

      expect((await listHooks(root))).toHaveLength(1);
      expect((await loadHook("capture-steps", root)).events).toEqual(["step.ok"]);
      expect(log.map((item) => item.event)).toEqual(["step.ok"]);
      expect(run.events.some((event) => event.type === "hook.ok")).toBe(true);
    });
  });
});
