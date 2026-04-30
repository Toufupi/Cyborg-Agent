import { describe, expect, it } from "vitest";
import { parseJsonContent, smokeModel, type ModelClient } from "../src/model-client.js";
import type { ModelProfile } from "../src/config.js";

describe("model client helpers", () => {
  it("parses fenced JSON model content", () => {
    expect(parseJsonContent("```json\n{\"ok\":true}\n```")).toEqual({ ok: true });
  });

  it("runs a model smoke check through an injected client", async () => {
    const client: ModelClient = {
      async completeJson() {
        return { ok: true, kind: "model_smoke" };
      }
    };
    const profile: ModelProfile = {
      base_url: "http://localhost:11434/v1",
      model: "fake",
      role: "small"
    };

    const result = await smokeModel(profile, client);

    expect(result.ok).toBe(true);
    expect(result.model).toBe("fake");
  });
});
