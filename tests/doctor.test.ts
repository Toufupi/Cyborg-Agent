import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { doctorCyborg } from "../src/doctor.js";
import { addTool } from "../src/registry.js";
import { addTask } from "../src/task.js";
import { fakeToolRegistration, withTempWorkspace, writeJson } from "./helpers.js";

describe("cyborg doctor", () => {
  it("checks registered tools and task tool references", async () => {
    await withTempWorkspace(async (root) => {
      const toolRoot = path.join(root, "tool");
      await mkdir(path.join(toolRoot, "node_modules"), { recursive: true });
      await writeFile(path.join(toolRoot, "package.json"), JSON.stringify({ name: "doctor-demo" }), "utf8");
      const toolFile = await writeJson(root, "tool.json", fakeToolRegistration({
        name: "doctor-demo",
        runtime: {
          type: "node",
          cwd: toolRoot,
          package_manager: "npm",
          isolated: true
        }
      }));
      await addTool(toolFile, root);
      const taskFile = await writeJson(root, "task.json", {
        name: "doctor-task",
        goal: "Check doctor task references.",
        steps: [{
          name: "render",
          tool: "doctor-demo",
          action: "render",
          input: {}
        }]
      });
      await addTask(taskFile, root);

      const result = await doctorCyborg(root);

      expect(result.ok).toBe(true);
      expect(result.tools[0]?.tool).toBe("doctor-demo");
      expect(result.checks.some((check) => check.name === "task.doctor-task.render.tool" && check.ok)).toBe(true);
    });
  });

  it("reports missing task tools", async () => {
    await withTempWorkspace(async (root) => {
      const taskFile = await writeJson(root, "task.json", {
        name: "broken-task",
        goal: "Check missing tools.",
        steps: [{
          name: "missing",
          tool: "missing-tool",
          action: "render",
          input: {}
        }]
      });
      await addTask(taskFile, root);

      const result = await doctorCyborg(root);

      expect(result.ok).toBe(false);
      expect(result.checks.some((check) => check.name === "task.broken-task.missing.tool" && !check.ok)).toBe(true);
    });
  });
});
