import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chooseModel } from "../src/model-router.js";
import { configPath, defaultConfig, initConfig, loadConfig } from "../src/config.js";
import { withTempWorkspace } from "./helpers.js";

describe("config", () => {
  it("creates a small-model-first default config rooted in the workspace", async () => {
    await withTempWorkspace(async (root) => {
      const config = defaultConfig(root);

      expect(config.models.routing.mode).toBe("auto");
      expect(config.models.small.role).toBe("small");
      expect(config.workspace.root).toBe(path.resolve(root));
    });
  });

  it("initializes and loads .cyborg/config.json", async () => {
    await withTempWorkspace(async (root) => {
      const initialized = await initConfig(root);
      const loaded = await loadConfig(root);

      expect(initialized.file).toBe(configPath(root));
      expect(loaded.workspace.root).toBe(path.resolve(root));
      expect(loaded.models.small.model).toBe("deepseek-v4-flash");
      expect(loaded.models.large?.model).toBe("deepseek-v4-pro");
      expect(loaded.models.small.api_key_env).toBe("DEEPSEEK_API_KEY");
    });
  });

  it("supports direct api_key fields for local private configs", async () => {
    await withTempWorkspace(async (root) => {
      await mkdir(path.dirname(configPath(root)), { recursive: true });
      await writeFile(configPath(root), JSON.stringify({
        models: {
          small: {
            base_url: "https://api.deepseek.com/v1",
            api_key: "local-secret",
            model: "deepseek-v4-flash",
            role: "small"
          },
          large: {
            base_url: "https://api.deepseek.com/v1",
            api_key: "local-secret",
            model: "deepseek-v4-pro",
            role: "large"
          },
          routing: {
            mode: "auto"
          }
        }
      }), "utf8");

      const config = await loadConfig(root);

      expect(config.models.small.api_key).toBe("local-secret");
      expect(config.models.large?.api_key).toBe("local-secret");
    });
  });

  it("validates custom routing and picks large model for fallback reasons", async () => {
    await withTempWorkspace(async (root) => {
      await mkdir(path.dirname(configPath(root)), { recursive: true });
      await writeFile(configPath(root), JSON.stringify({
        models: {
          small: {
            base_url: "http://small.local/v1",
            model: "small",
            role: "small"
          },
          large: {
            base_url: "http://large.local/v1",
            model: "large",
            role: "large"
          },
          routing: {
            mode: "auto",
            fallback_on: ["runtime_error"]
          }
        }
      }), "utf8");

      const config = await loadConfig(root);

      expect(chooseModel(config, "default").model).toBe("small");
      expect(chooseModel(config, "fallback").model).toBe("large");
    });
  });
});
