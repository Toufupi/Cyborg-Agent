import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executeShellLine, createShellState } from "../src/agent/shell.js";
import { addAgentProfile } from "../src/agents.js";
import { addHook } from "../src/hooks.js";
import { addTool } from "../src/registry.js";
import { addTask } from "../src/task.js";
import { fakeToolRegistration, withTempWorkspace, writeJson } from "./helpers.js";

describe("interactive shell", () => {
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
});
