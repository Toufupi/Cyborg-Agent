import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createNodeTool } from "../src/tool-creator.js";
import { withTempWorkspace } from "./helpers.js";

describe("tool creator", () => {
  it("creates a local Node A2C2A tool scaffold", async () => {
    await withTempWorkspace(async (root) => {
      const result = await createNodeTool(root, {
        name: "demo-tool",
        description: "Demo generated tool."
      });

      await expect(access(result.packageFile)).resolves.toBeUndefined();
      await expect(access(result.scriptFile)).resolves.toBeUndefined();
      await expect(access(result.registrationFile)).resolves.toBeUndefined();
      expect(result.registration.name).toBe("demo-tool");
      expect(result.registration.runtime?.isolated).toBe(true);
    });
  });
});
