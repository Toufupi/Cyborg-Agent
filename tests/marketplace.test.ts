import path from "node:path";
import { describe, expect, it } from "vitest";
import { installMarketplaceTool, listMarketplaceTools } from "../src/marketplace.js";
import { listTools } from "../src/registry.js";
import { fakeToolRegistration, withTempWorkspace, writeJson } from "./helpers.js";

describe("tool marketplace", () => {
  it("lists and installs local marketplace tool registrations", async () => {
    await withTempWorkspace(async (root) => {
      await writeJson(root, "tool.json", fakeToolRegistration({
        name: "market-tool",
        description: "Marketplace tool."
      }));
      const marketplace = await writeJson(root, "marketplace.json", {
        schema: "cyborg.marketplace.v0.1",
        name: "local",
        tools: [{
          name: "market-tool",
          description: "Marketplace tool.",
          category: "test",
          registration: "tool.json",
          tags: ["demo"]
        }]
      });

      const entries = await listMarketplaceTools(marketplace);
      const installed = await installMarketplaceTool(marketplace, "market-tool", root, "installed-tool");

      expect(entries[0]?.registration).toBe(path.join(root, "tool.json"));
      expect(installed.added.registration.name).toBe("installed-tool");
      expect((await listTools(root)).map((tool) => tool.registration.name)).toEqual(["installed-tool"]);
    });
  });

  it("rejects unknown marketplace tools", async () => {
    await withTempWorkspace(async (root) => {
      const marketplace = await writeJson(root, "marketplace.json", {
        schema: "cyborg.marketplace.v0.1",
        name: "local",
        tools: []
      });

      await expect(installMarketplaceTool(marketplace, "missing", root)).rejects.toThrow("does not contain tool");
    });
  });
});
