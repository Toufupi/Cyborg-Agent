import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyShellLine, executeShellLine, executeShellLineStream, createShellState } from "../src/agent/shell.js";
import { addAgentProfile } from "../src/agents.js";
import { addHook } from "../src/hooks.js";
import { addTool } from "../src/registry.js";
import { addTask } from "../src/task.js";
import { fakeToolRegistration, withTempWorkspace, writeJson } from "./helpers.js";
import type { ModelClient, ModelMessage } from "../src/model-client.js";

class CapturingModelClient implements ModelClient {
  messages: ModelMessage[][] = [];

  async completeJson(_profile: Parameters<ModelClient["completeJson"]>[0], messages: ModelMessage[]) {
    this.messages.push(messages);
    return { kind: "final", message: "ok", confidence: 1, reason: "test" };
  }
}

describe("interactive shell", () => {
  it("classifies shell lines through one shared router", () => {
    expect(classifyShellLine("")).toEqual({ kind: "empty" });
    expect(classifyShellLine("/tools")).toEqual({ kind: "command", command: "/tools" });
    expect(classifyShellLine("help")).toEqual({ kind: "command", command: "/help" });
    expect(classifyShellLine("quit")).toEqual({ kind: "exit" });
    expect(classifyShellLine("list approvals")).toEqual({ kind: "shortcut", intent: "approvals" });
    expect(classifyShellLine("run task daily-report")).toEqual({ kind: "shortcut", intent: "run_task" });
    expect(classifyShellLine("please build a report")).toEqual({ kind: "planner" });
  });

  it("lists tools and tasks from persistent shell state", async () => {
    await withTempWorkspace(async (root) => {
      const toolFile = await writeJson(root, "tool.json", fakeToolRegistration({
        name: "chat-tool"
      }));
      await addTool(toolFile, root);
      const taskFile = await writeJson(root, "task.json", {
        name: "chat-task",
        goal: "Exercise the shell task list."
      });
      await addTask(taskFile, root);

      const state = await createShellState(root);
      const tools = await executeShellLine("/tools", state);
      const tasks = await executeShellLine("list tasks", state);

      expect(tools.output).toContain("chat-tool");
      expect(tasks.output).toContain("chat-task");
      expect(tasks.output).toContain("Exercise the shell task list");
    });
  });

  it("runs slash task commands and stores chat history", async () => {
    await withTempWorkspace(async (root) => {
      await writeJson(root, "tool.json", fakeToolRegistration({
        name: "chat-runner",
        discovery: {
          strategy: "static",
          a2c2a: {
            command: process.execPath,
            args: ["-e", "process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ ok: true })))"]
          }
        }
      }));
      await addTool(path.join(root, "tool.json"), root);
      const taskFile = await writeJson(root, "task.json", {
        name: "chat-run",
        goal: "Run from shell.",
        steps: [{
          name: "step",
          tool: "chat-runner",
          action: "render",
          input: {}
        }]
      });
      await addTask(taskFile, root);

      const state = await createShellState(root);
      const result = await executeShellLine("/run chat-run", state);
      const session = JSON.parse(await readFile(path.join(state.session.runDir, "run.json"), "utf8")) as {
        events: Array<{ type: string; message: string }>;
      };

      expect(result.output).toContain("\"ok\": true");
      expect(result.output).toContain(".cyborg");
      expect(session.events.some((event) => event.type === "chat.user" && event.message === "/run chat-run")).toBe(true);
      expect(session.events.some((event) => event.type === "chat.assistant")).toBe(true);
    });
  });

  it("supports exit commands", async () => {
    await withTempWorkspace(async (root) => {
      const state = await createShellState(root);
      const result = await executeShellLine("/exit", state);

      expect(result.exit).toBe(true);
      expect(result.output).toContain("Session saved");
    });
  });

  it("lists hooks and agent profiles", async () => {
    await withTempWorkspace(async (root) => {
      const hookFile = await writeJson(root, "hook.json", {
        schema: "cyborg.hook.v0.1",
        name: "audit",
        events: ["task.start"],
        invocation: {
          command: process.execPath,
          args: ["-e", "process.stdin.resume()"]
        }
      });
      await addHook(hookFile, root);
      const agentFile = await writeJson(root, "agent.json", {
        schema: "cyborg.agent-profile.v0.1",
        name: "researcher",
        description: "Research task specialist."
      });
      await addAgentProfile(agentFile, root);

      const state = await createShellState(root);
      const hooks = await executeShellLine("/hooks", state);
      const agents = await executeShellLine("list agents", state);
      const help = await executeShellLine("/help", state);
      const approvals = await executeShellLine("/approvals", state);

      expect(hooks.output).toContain("audit");
      expect(hooks.output).toContain("task.start");
      expect(agents.output).toContain("researcher");
      expect(agents.output).toContain("Research task specialist");
      expect(help.output).toContain("/doctor");
      expect(help.output).toContain("/agent-status");
      expect(help.output).toContain("/tool-doctor");
      expect(help.output).toContain("/tool-env");
      expect(approvals.output).toContain("No pending approvals");
    });
  });

  it("resumes chat sessions and builds compact conversation context", async () => {
    await withTempWorkspace(async (root) => {
      const first = await createShellState(root);
      await executeShellLine("/tools", first);

      const resumed = await createShellState(root, { continueLatest: true });
      const session = await executeShellLine("/session", resumed);

      expect(resumed.session.id).toBe(first.session.id);
      expect(session.output).toContain("\"resumed\": true");
      expect(session.output).toContain("/tools");
      expect(session.output).toContain("context_pressure");
      expect(session.output).toContain("last_compaction");
    });
  });

  it("passes compact chat history into planner model requests", async () => {
    await withTempWorkspace(async (root) => {
      const modelClient = new CapturingModelClient();
      const state = await createShellState(root, { modelClient });
      await executeShellLine("/tools", state);
      const result = await executeShellLine("please continue from earlier", state);
      const userPayload = JSON.parse(modelClient.messages[0]?.find((message) => message.role === "user")?.content ?? "{}") as {
        conversation?: {
          recent_messages?: Array<{ role: string; content: string }>;
          context_pressure?: { level?: string };
        };
      };

      expect(result.output).toContain("ok");
      expect(userPayload.conversation?.recent_messages?.some((message) => message.content === "/tools")).toBe(true);
      expect(userPayload.conversation?.recent_messages?.some((message) => message.role === "assistant" && message.content.includes("No tools registered"))).toBe(true);
      expect(userPayload.conversation?.context_pressure?.level).toBeDefined();
    });
  });

  it("streams natural language shell input through the agent planner", async () => {
    await withTempWorkspace(async (root) => {
      const modelClient = new CapturingModelClient();
      const state = await createShellState(root, { modelClient });
      const stream = executeShellLineStream("please answer through stream", state);
      const events = [];
      let next = await stream.next();
      while (!next.done) {
        events.push(next.value.type);
        next = await stream.next();
      }

      expect(next.value.output).toContain("[agent]");
      expect(events).toContain("shell.user");
      expect(events).toContain("shell.agent.event");
      expect(events).toContain("shell.agent.result");
    });
  });
});
