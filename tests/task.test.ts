import { describe, expect, it } from "vitest";
import { addTask, listTasks, loadTask, taskPath } from "../src/task.js";
import { withTempWorkspace, writeJson } from "./helpers.js";

describe("tasks", () => {
  it("adds, lists, and loads scheduled task configs", async () => {
    await withTempWorkspace(async (root) => {
      const source = await writeJson(root, "research.json", {
        name: "research-progress",
        description: "Daily research progress report.",
        schedule: "0 8 * * *",
        goal: "Create a concise research report.",
        tools: ["page-generator-cli"],
        outputs: {
          html: "reports/research.html"
        },
        steps: [{
          name: "render-report",
          tool: "page-generator-cli",
          action: "render",
          input: {
            title: "Report"
          }
        }]
      });

      const added = await addTask(source, root);
      expect(added.output).toBe(taskPath("research-progress", root));
      expect(added.task.model_profile).toBe("auto");

      const listed = await listTasks(root);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.task.name).toBe("research-progress");

      const loaded = await loadTask("research-progress", root);
      expect(loaded.steps[0]?.action).toBe("render");
    });
  });

  it("rejects invalid task names early", async () => {
    await withTempWorkspace(async (root) => {
      const source = await writeJson(root, "bad-task.json", {
        name: "Bad Task",
        goal: "This should not pass."
      });

      await expect(addTask(source, root)).rejects.toThrow();
    });
  });
});
