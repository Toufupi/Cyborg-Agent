import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addMemory, extractMemoriesFromRun, listMemories, memoryContext, searchMemories } from "../src/memory.js";
import { withTempWorkspace } from "./helpers.js";

describe("memory", () => {
  it("adds, lists, and searches structured memory records", async () => {
    await withTempWorkspace(async (root) => {
      await addMemory(root, {
        type: "tool_memory",
        title: "Page render requires title",
        summary: "page-generator-cli page.render should include input.title and output.",
        tags: ["page", "render"],
        tool: "page-generator-cli"
      });
      await addMemory(root, {
        type: "preference_memory",
        title: "Prefer light reports",
        summary: "Default report pages should use light mode unless requested otherwise.",
        tags: ["theme"]
      });

      const listed = await listMemories(root);
      const found = await searchMemories(root, {
        goal: "render a page report",
        tool: "page-generator-cli",
        limit: 1
      });

      expect(listed).toHaveLength(2);
      expect(found[0]?.memory.title).toBe("Page render requires title");
      expect(memoryContext(found)).toEqual([
        expect.objectContaining({
          type: "tool_memory",
          tool: "page-generator-cli"
        })
      ]);
    });
  });

  it("extracts reusable error and tool memories from run observations", async () => {
    await withTempWorkspace(async (root) => {
      const runDir = path.join(root, ".cyborg", "runs", "agent-demo");
      await mkdir(runDir, { recursive: true });
      await writeFile(path.join(runDir, "run.json"), JSON.stringify({
        id: "agent-demo",
        events: [
          {
            type: "agent.plan",
            data: {
              plan: {
                kind: "call_tool",
                tool: "page-generator-cli",
                request: {
                  action: "page.render"
                }
              }
            }
          },
          {
            type: "agent.observation",
            data: {
              observation: {
                ok: false,
                error: {
                  type: "input_validation_error",
                  message: "Input failed validation.",
                  details: {
                    issues: [
                      { path: "$.input.title", code: "missing_required" }
                    ]
                  }
                }
              }
            }
          }
        ]
      }), "utf8");

      const first = await extractMemoriesFromRun(root, runDir);
      const second = await extractMemoriesFromRun(root, path.join(runDir, "run.json"));
      const found = await searchMemories(root, {
        goal: "page render missing title",
        tool: "page-generator-cli",
        limit: 5
      });
      const context = memoryContext(found);
      expect(Array.isArray(context)).toBe(true);

      expect(first.created).toHaveLength(2);
      expect(second.created).toHaveLength(0);
      expect(second.skipped).toBe(2);
      expect(found.map((item) => item.memory.type)).toContain("error_memory");
      expect(found.map((item) => item.memory.type)).toContain("tool_memory");
      expect((context as unknown[])[0]).toEqual(expect.objectContaining({
        tool: "page-generator-cli",
        error_type: "input_validation_error"
      }));
    });
  });
});
