import { describe, expect, it } from "vitest";
import { addMemory, listMemories, memoryContext, searchMemories } from "../src/memory.js";
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
});
