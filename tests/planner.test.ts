import { readFile, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentGoal } from "../src/agent/planner.js";
import type { ModelClient } from "../src/model-client.js";
import { addTool } from "../src/registry.js";
import { listTools } from "../src/registry.js";
import { addTask } from "../src/task.js";
import type { JsonValue } from "../src/types.js";
import { fakeToolRegistration, withTempWorkspace, writeJson } from "./helpers.js";

class FakeModelClient implements ModelClient {
  calls = 0;

  constructor(private readonly responses: JsonValue[]) {}

  async completeJson() {
    const response = this.responses[this.calls];
    this.calls += 1;
    if (response === undefined) {
      throw new Error("No fake model response configured.");
    }
    return response;
  }
}

describe("agent planner loop", () => {
  it("uses a model plan to run an existing task", async () => {
    await withTempWorkspace(async (root) => {
      const scriptPath = path.join(root, "tool.mjs");
      await writeFile(scriptPath, [
        "process.stdin.resume();",
        "process.stdin.on('end', () => console.log(JSON.stringify({ ok: true })));"
      ].join("\n"), "utf8");
      const toolFile = await writeJson(root, "tool.json", fakeToolRegistration({
        name: "report-tool",
        discovery: {
          strategy: "static",
          a2c2a: { command: process.execPath, args: [scriptPath] }
        }
      }));
      await addTool(toolFile, root);
      const taskFile = await writeJson(root, "task.json", {
        name: "daily-report",
        goal: "Render a daily report.",
        steps: [{ name: "render", tool: "report-tool", action: "report.render", input: {} }]
      });
      await addTask(taskFile, root);

      const modelClient = new FakeModelClient([
        { kind: "run_task", task: "daily-report", confidence: 0.9, reason: "registered recurring task" }
      ]);

      const result = await runAgentGoal("make the daily report", root, { modelClient });
      const run = JSON.parse(await readFile(result.file, "utf8")) as { events: Array<{ type: string }> };

      expect(result.output).toContain("\"ok\": true");
      expect(result.plan.kind).toBe("run_task");
      expect(result.steps).toHaveLength(1);
      expect(run.events.some((event) => event.type === "agent.plan")).toBe(true);
      expect(modelClient.calls).toBe(1);
    });
  });

  it("repairs an A2C2A tool request after structured validation errors", async () => {
    await withTempWorkspace(async (root) => {
      const scriptPath = path.join(root, "repair-tool.mjs");
      await writeFile(scriptPath, [
        "let raw = '';",
        "process.stdin.on('data', chunk => { raw += chunk; });",
        "process.stdin.on('end', () => {",
        "  const request = JSON.parse(raw);",
        "  if (!request.input.title) {",
        "    console.log(JSON.stringify({ ok: false, error: { type: 'input_validation_error', details: { issues: [{ path: '$.input.title', code: 'missing_required' }] } } }));",
        "    process.exit(1);",
        "  }",
        "  console.log(JSON.stringify({ ok: true, result: { title: request.input.title } }));",
        "});"
      ].join("\n"), "utf8");
      const toolFile = await writeJson(root, "tool.json", fakeToolRegistration({
        name: "page-tool",
        discovery: {
          strategy: "static",
          a2c2a: { command: process.execPath, args: [scriptPath] }
        }
      }));
      await addTool(toolFile, root);

      const modelClient = new FakeModelClient([
        {
          kind: "call_tool",
          tool: "page-tool",
          request: { a2c2a: "0.1", action: "page.render", input: {} },
          confidence: 0.8,
          reason: "page tool can render"
        },
        {
          kind: "call_tool",
          tool: "page-tool",
          request: { a2c2a: "0.1", action: "page.render", input: { title: "Fixed" } },
          confidence: 0.9,
          reason: "fixed missing title"
        },
        {
          kind: "final",
          message: "Rendered after repair.",
          confidence: 0.9,
          reason: "tool succeeded"
        }
      ]);

      const result = await runAgentGoal("render a page", root, { modelClient, maxRepairAttempts: 1, maxSteps: 2 });
      const run = JSON.parse(await readFile(result.file, "utf8")) as { events: Array<{ type: string }> };

      expect(result.output).toContain("Rendered after repair");
      expect(run.events.some((event) => event.type === "agent.observation")).toBe(true);
      expect(modelClient.calls).toBe(3);
    });
  });

  it("inspects a tool before calling it in a multi-step loop", async () => {
    await withTempWorkspace(async (root) => {
      const scriptPath = path.join(root, "manifest-tool.mjs");
      await writeFile(scriptPath, [
        "if (process.argv.includes('manifest')) { console.log(JSON.stringify({ actions: { 'page.render': {} } })); process.exit(0); }",
        "let raw = '';",
        "process.stdin.on('data', chunk => { raw += chunk; });",
        "process.stdin.on('end', () => console.log(JSON.stringify({ ok: true, result: { html: 'ok' } })));"
      ].join("\n"), "utf8");
      const toolFile = await writeJson(root, "tool.json", fakeToolRegistration({
        name: "manifest-tool",
        discovery: {
          strategy: "static",
          manifest: { command: process.execPath, args: [scriptPath, "manifest"] },
          a2c2a: { command: process.execPath, args: [scriptPath] }
        }
      }));
      await addTool(toolFile, root);

      const modelClient = new FakeModelClient([
        { kind: "inspect_tool", tool: "manifest-tool", include: "manifest", reason: "need contract" },
        {
          kind: "call_tool",
          tool: "manifest-tool",
          request: { a2c2a: "0.1", action: "page.render", input: { title: "Fixed" } },
          confidence: 0.9,
          reason: "contract inspected"
        },
        { kind: "final", message: "Done.", confidence: 1, reason: "tool succeeded" }
      ]);

      const result = await runAgentGoal("render a page", root, { modelClient, maxSteps: 3 });

      expect(result.output).toBe("Done.");
      expect(result.steps.map((step) => step.plan.kind)).toEqual(["inspect_tool", "call_tool", "final"]);
    });
  });

  it("falls back to the large model after repeated repair failure", async () => {
    await withTempWorkspace(async (root) => {
      await mkdir(path.join(root, ".cyborg"), { recursive: true });
      await writeFile(path.join(root, ".cyborg", "config.json"), JSON.stringify({
        models: {
          small: { base_url: "http://small.local/v1", model: "small", role: "small" },
          large: { base_url: "http://large.local/v1", model: "large", role: "large" },
          routing: { mode: "auto", fallback_on: ["max_retries_exceeded"] }
        }
      }), "utf8");
      const scriptPath = path.join(root, "always-fails.mjs");
      await writeFile(scriptPath, [
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        " console.log(JSON.stringify({ ok: false, error: { type: 'input_validation_error', message: 'still bad' } }));",
        " process.exit(1);",
        "});"
      ].join("\n"), "utf8");
      const toolFile = await writeJson(root, "tool.json", fakeToolRegistration({
        name: "bad-tool",
        discovery: {
          strategy: "static",
          a2c2a: { command: process.execPath, args: [scriptPath] }
        }
      }));
      await addTool(toolFile, root);
      const modelClient = new FakeModelClient([
        { kind: "call_tool", tool: "bad-tool", request: { a2c2a: "0.1", action: "x", input: {} } },
        { kind: "call_tool", tool: "bad-tool", request: { a2c2a: "0.1", action: "x", input: { retry: 1 } } },
        { kind: "answer", message: "Escalated and stopped.", confidence: 0.5, reason: "large model fallback" }
      ]);

      const result = await runAgentGoal("try bad tool", root, { modelClient, maxRepairAttempts: 2, maxSteps: 1 });

      expect(result.output).toContain("Escalated");
      expect(result.attempts.some((attempt) => attempt.model === "large")).toBe(true);
    });
  });

  it("creates and registers a reusable tool from an agent step", async () => {
    await withTempWorkspace(async (root) => {
      const modelClient = new FakeModelClient([
        {
          kind: "create_tool",
          name: "paper-ranker",
          description: "Rank research papers for a topic.",
          category: "research",
          register: true,
          reason: "repeatable capability is missing"
        },
        {
          kind: "inspect_context",
          reason: "verify registration"
        },
        {
          kind: "final",
          message: "Created paper-ranker.",
          confidence: 1,
          reason: "tool registered"
        }
      ]);

      const result = await runAgentGoal("create a paper ranking tool", root, { modelClient, maxSteps: 3 });
      const tools = await listTools(root);
      const run = JSON.parse(await readFile(result.file, "utf8")) as {
        events: Array<{ type: string; data?: { observation?: { run?: string; a2a?: string } } }>;
      };
      const createObservation = run.events.find((event) => event.type === "agent.observation" && event.data?.observation?.run);

      expect(result.output).toBe("Created paper-ranker.");
      expect(tools.map(({ registration }) => registration.name)).toContain("paper-ranker");
      expect(result.steps.map((step) => step.plan.kind)).toEqual(["create_tool", "inspect_context", "final"]);
      expect(createObservation?.data?.observation?.run).toContain("agent-tool-builder");
      expect(createObservation?.data?.observation?.a2a).toContain("a2a.json");
    });
  });

  it("saves a structured run when the model is unavailable", async () => {
    await withTempWorkspace(async (root) => {
      const modelClient: ModelClient = {
        async completeJson() {
          throw new Error("model offline");
        }
      };

      const result = await runAgentGoal("do something", root, { modelClient });
      const run = JSON.parse(await readFile(result.file, "utf8")) as {
        events: Array<{ type: string; data?: { error?: { type?: string; message?: string } } }>;
      };
      const error = run.events.find((event) => event.type === "agent.error");

      expect(result.output).toContain("\"ok\": false");
      expect(result.plan.kind).toBe("final");
      expect(error?.data?.error?.type).toBe("model_error");
      expect(error?.data?.error?.message).toBe("model offline");
    });
  });

  it("runs a planner step through an OpenAI-compatible HTTP model endpoint", async () => {
    await withTempWorkspace(async (root) => {
      const scriptPath = path.join(root, "tool.mjs");
      await writeFile(scriptPath, [
        "process.stdin.resume();",
        "process.stdin.on('end', () => console.log(JSON.stringify({ ok: true, result: { rendered: true } })));"
      ].join("\n"), "utf8");
      await addTool(await writeJson(root, "tool.json", fakeToolRegistration({
        name: "report-tool",
        discovery: {
          strategy: "static",
          a2c2a: { command: process.execPath, args: [scriptPath] }
        }
      })), root);
      await addTask(await writeJson(root, "task.json", {
        name: "demo-report",
        goal: "Render a demo report.",
        steps: [{ name: "render", tool: "report-tool", action: "report.render", input: {} }]
      }), root);
      const { server, url } = await startPlannerServer({
        kind: "run_task",
        task: "demo-report",
        confidence: 0.9,
        reason: "registered task"
      });
      await mkdir(path.join(root, ".cyborg"), { recursive: true });
      await writeFile(path.join(root, ".cyborg", "config.json"), JSON.stringify({
        models: {
          small: { base_url: url, model: "fake-small", role: "small" },
          routing: { mode: "small_only" }
        }
      }), "utf8");

      try {
        const result = await runAgentGoal("run demo report", root);

        expect(result.plan.kind).toBe("run_task");
        expect(result.output).toContain("demo-report");
      } finally {
        await closeServer(server);
      }
    });
  });
});

async function startPlannerServer(response: unknown) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify(response)
          }
        }]
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Planner server did not expose a TCP address.");
  }
  return { server, url: `http://127.0.0.1:${address.port}/v1` };
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
