import { describe, expect, it } from "vitest";
import http from "node:http";
import { parseJsonContent, smokeModel, OpenAICompatibleModelClient, type ModelClient } from "../src/model-client.js";
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

  it("calls an OpenAI-compatible chat completions endpoint", async () => {
    const { server, url, requests } = await startFakeOpenAICompatibleServer({
      kind: "run_task",
      task: "demo-task",
      confidence: 0.9,
      reason: "registered task"
    });
    try {
      const profile: ModelProfile = {
        base_url: url,
        model: "fake-small",
        role: "small"
      };
      const result = await new OpenAICompatibleModelClient().completeJson(profile, [
        { role: "system", content: "Return JSON." },
        { role: "user", content: "run demo task" }
      ]);

      expect(result).toEqual({
        kind: "run_task",
        task: "demo-task",
        confidence: 0.9,
        reason: "registered task"
      });
      expect(requests[0]?.url).toBe("/v1/chat/completions");
      expect(requests[0]?.body.model).toBe("fake-small");
      expect(requests[0]?.body.response_format).toEqual({ type: "json_object" });
    } finally {
      await closeServer(server);
    }
  });

  it("prefers direct api_key over api_key_env when present", async () => {
    const { server, url, requests } = await startFakeOpenAICompatibleServer({ ok: true });
    process.env.TEST_MODEL_KEY = "from-env";
    try {
      await new OpenAICompatibleModelClient().completeJson({
        base_url: url,
        api_key: "from-config",
        api_key_env: "TEST_MODEL_KEY",
        model: "fake-small",
        role: "small"
      }, [
        { role: "system", content: "Return JSON." },
        { role: "user", content: "hello" }
      ]);

      expect(requests[0]?.authorization).toBe("Bearer from-config");
    } finally {
      delete process.env.TEST_MODEL_KEY;
      await closeServer(server);
    }
  });

  it("returns usage metadata from OpenAI-compatible responses", async () => {
    const { server, url } = await startFakeOpenAICompatibleServer({ ok: true });
    try {
      const result = await new OpenAICompatibleModelClient().completeJsonWithUsage({
        base_url: url,
        model: "fake-small",
        role: "small"
      }, [
        { role: "system", content: "Return JSON." },
        { role: "user", content: "hello" }
      ]);

      expect(result.json).toEqual({ ok: true });
      expect(result.usage?.total_tokens).toBe(18);
    } finally {
      await closeServer(server);
    }
  });


  it("returns structured smoke errors when the endpoint is down", async () => {
    const result = await smokeModel({
      base_url: "http://127.0.0.1:9/v1",
      model: "missing",
      role: "small"
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      error: {
        type: "model_connection_failed"
      }
    });
  });
});

async function startFakeOpenAICompatibleServer(response: unknown) {
  const requests: Array<{ url: string; authorization?: string; body: Record<string, unknown> }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      requests.push({
        url: req.url ?? "",
        authorization: req.headers.authorization,
        body: JSON.parse(raw) as Record<string, unknown>
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify(response)
          }
        }],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18
        }
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fake server did not expose a TCP address.");
  }
  return {
    server,
    requests,
    url: `http://127.0.0.1:${address.port}/v1`
  };
}

function closeServer(server: http.Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
