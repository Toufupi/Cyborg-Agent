import { mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addTool, getTool, listTools, registryRoot, removeTool } from "../src/registry.js";
import { fakeToolRegistration, withTempWorkspace, writeJson } from "./helpers.js";

describe("tool registry", () => {
  it("adds, lists, gets, aliases, and removes tool registrations", async () => {
    await withTempWorkspace(async (root) => {
      const sourceDir = path.join(root, "fixtures");
      await mkdir(sourceDir, { recursive: true });
      const source = await writeJson(root, "fixtures/fake-tool.json", fakeToolRegistration());

      expect(await listTools(root)).toEqual([]);

      const added = await addTool(source, root);
      expect(added.output).toBe(path.join(registryRoot(root), "fake-tool.json"));

      const listed = await listTools(root);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.registration.name).toBe("fake-tool");

      const alias = await addTool(source, root, "fake-alias");
      expect(alias.registration.name).toBe("fake-alias");
      expect((await getTool("fake-alias", root)).registration.name).toBe("fake-alias");

      await removeTool("fake-tool", root);
      expect((await listTools(root)).map((tool) => tool.registration.name)).toEqual(["fake-alias"]);
    });
  });

  it("rejects unsupported registration schemas", async () => {
    await withTempWorkspace(async (root) => {
      const source = await writeJson(root, "bad-tool.json", {
        ...fakeToolRegistration(),
        schema: "unknown"
      });

      await expect(addTool(source, root)).rejects.toThrow("Unsupported tool registration schema");
    });
  });
});
