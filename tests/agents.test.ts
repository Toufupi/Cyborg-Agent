import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadA2ATranscript } from "../src/a2a.js";
import { addAgentProfile, cancelSubagentStatus, listAgentProfiles, listSubagentRuns, loadAgentProfile, loadSubagentStatus, runSubagent, runToolBuilderSubagent } from "../src/agents.js";
import { readAuditEvents } from "../src/audit.js";
import { addTool } from "../src/registry.js";
import { addTask } from "../src/task.js";
import { fakeToolRegistration, withTempWorkspace, writeJson } from "./helpers.js";

describe("agent profiles and subagents", () => {
  it("registers profiles and runs allowed tasks as subagents", async () => {
    await withTempWorkspace(async (root) => {
      const toolScript = path.join(root, "tool.mjs");
      await writeFile(toolScript, "process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ ok: true })));", "utf8");
      const toolFile = await writeJson(root, "tool.json", fakeToolRegistration({
        name: "report-tool",
        discovery: {
          strategy: "static",
          a2c2a: {
            command: process.execPath,
            args: [toolScript]
          }
        }
      }));
      await addTool(toolFile, root);
      const taskFile = await writeJson(root, "task.json", {
        name: "report-task",
        goal: "Run a report.",
        steps: [{
          name: "render",
          tool: "report-tool",
          action: "render",
          input: {}
        }]
      });
      await addTask(taskFile, root);

      const profileFile = await writeJson(root, "agent.json", {
        schema: "cyborg.agent-profile.v0.1",
        name: "researcher",
        description: "Focused reporting agent.",
        model_profile: "small",
        policy: "research-policy",
        allowed_tools: ["report-tool"],
        allowed_tasks: ["report-task"],
        instructions: "Prefer concise reports."
      });
      await writeJson(root, "policy.json", {
        schema: "cyborg.policy.v0.1",
        name: "research-policy",
        tools: {
          allow: ["report-tool"],
          deny: []
        },
        tasks: {
          allow: ["report-task"],
          deny: []
        },
        commands: {
          allow: ["node"],
          deny: ["powershell", "cmd", "bash", "sh"]
        },
        env: {
          allow: ["CYBORG_SHELL", "CYBORG_WORKSPACE_ROOT", "CYBORG_TOOL_REGISTRY", "CYBORG_SESSION_ID", "PATH"],
          deny_patterns: [".*(API_KEY|TOKEN|PASSWORD|PRIVATE_KEY|SECRET)$"]
        }
      });
      const { addPolicy } = await import("../src/policy.js");
      await addPolicy(path.join(root, "policy.json"), root);
      await addAgentProfile(profileFile, root);

      const result = await runSubagent("researcher", "report-task", root);
      const run = JSON.parse(await readFile(result.file, "utf8")) as { events: Array<{ type: string; data?: unknown }> };
      const transcript = await loadA2ATranscript(path.join(path.dirname(result.file), "a2a.json"));
      const status = await loadSubagentStatus(path.join(path.dirname(result.file), "subagent-status.json"));

      expect((await listAgentProfiles(root))).toHaveLength(1);
      expect((await loadAgentProfile("researcher", root)).model_profile).toBe("small");
      expect(run.events.map((event) => event.type)).toEqual(["subagent.start", "subagent.end"]);
      expect(JSON.stringify(run.events)).toContain("report-task");
      expect(transcript.messages.map((message) => message.type)).toEqual(["delegate", "accept", "progress", "progress", "progress", "result"]);
      expect(transcript.messages[0]?.from.agent).toBe("cyborg");
      expect(transcript.messages[0]?.to.agent).toBe("researcher");
      expect(transcript.messages.at(-1)?.data).toEqual({ taskRun: expect.stringContaining("report-task") });
      expect(status.status).toBe("completed");
      expect(status.agent).toBe("researcher");
      expect(status.task).toBe("report-task");
      expect(status.task_run).toContain("report-task");
      expect(status.worker).toBe("task");
      expect(status.progress?.phase).toBe("completed");
      expect(status.heartbeat_at).toBeTruthy();
      expect(await listSubagentRuns(root)).toHaveLength(0);
      expect((await listSubagentRuns(root, { includeCompleted: true }))[0]).toEqual(expect.objectContaining({
        run_id: status.run_id,
        live: false,
        stale: false
      }));
      expect((await readAuditEvents(root)).map((event) => event.type)).toContain("subagent.end");
    });
  });

  it("creates agent profiles from Markdown descriptor files", async () => {
    await withTempWorkspace(async (root) => {
      const file = path.join(root, "researcher.md");
      await writeFile(file, [
        "---",
        "name: researcher",
        "description: Focused research specialist",
        "model_profile: small",
        "allowed_tools: [page-generator-cli, search-tool]",
        "allowed_tasks: [research-progress]",
        "---",
        "Prefer compact reports with evidence and source links."
      ].join("\n"), "utf8");

      const result = await addAgentProfile(file, root);
      const loaded = await loadAgentProfile("researcher", root);

      expect(result.output).toContain("researcher.json");
      expect(loaded.description).toBe("Focused research specialist");
      expect(loaded.model_profile).toBe("small");
      expect(loaded.allowed_tools).toEqual(["page-generator-cli", "search-tool"]);
      expect(loaded.allowed_tasks).toEqual(["research-progress"]);
      expect(loaded.timeout_ms).toBe(30 * 60 * 1000);
      expect(loaded.max_concurrency).toBe(1);
      expect(loaded.instructions).toContain("compact reports");
    });
  });

  it("blocks subagents from unauthorized tasks or tools", async () => {
    await withTempWorkspace(async (root) => {
      const toolFile = await writeJson(root, "tool.json", fakeToolRegistration({ name: "blocked-tool" }));
      await addTool(toolFile, root);
      const taskFile = await writeJson(root, "task.json", {
        name: "blocked-task",
        goal: "Should be denied.",
        steps: [{
          name: "step",
          tool: "blocked-tool",
          action: "render",
          input: {}
        }]
      });
      await addTask(taskFile, root);
      const profileFile = await writeJson(root, "agent.json", {
        schema: "cyborg.agent-profile.v0.1",
        name: "limited",
        allowed_tools: ["other-tool"],
        allowed_tasks: ["other-task"]
      });
      await addAgentProfile(profileFile, root);

      await expect(runSubagent("limited", "blocked-task", root)).rejects.toThrow("not allowed to run task");
    });
  });

  it("marks subagent status files as cancelled", async () => {
    await withTempWorkspace(async (root) => {
      const file = await writeJson(root, "subagent-status.json", {
        schema: "cyborg.subagent-status.v0.1",
        run_id: "run-1",
        agent: "researcher",
        task: "report",
        status: "running",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });

      const status = await cancelSubagentStatus(file, "test cancel");

      expect(status.status).toBe("cancelled");
      expect(status.error?.message).toBe("test cancel");
    });
  });

  it("lists stale running subagent statuses", async () => {
    await withTempWorkspace(async (root) => {
      const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const runDir = path.join(root, ".cyborg", "runs", "agent-researcher-old");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(runDir, { recursive: true });
      await writeFile(path.join(runDir, "subagent-status.json"), JSON.stringify({
        schema: "cyborg.subagent-status.v0.1",
        run_id: "agent-researcher-old",
        agent: "researcher",
        task: "report",
        status: "running",
        created_at: oldTime,
        updated_at: oldTime,
        heartbeat_at: oldTime,
        worker: "task"
      }), "utf8");

      const runs = await listSubagentRuns(root);

      expect(runs).toHaveLength(1);
      expect(runs[0]?.stale).toBe(true);
      expect(runs[0]?.live).toBe(false);
    });
  });

  it("runs the built-in tool-builder subagent", async () => {
    await withTempWorkspace(async (root) => {
      const result = await runToolBuilderSubagent(root, {
        name: "summary-tool",
        description: "Summarize structured inputs.",
        category: "text",
        register: true
      });

      const status = await loadSubagentStatus(path.join(path.dirname(result.run), "subagent-status.json"));
      const transcript = await loadA2ATranscript(result.a2a);

      expect(result.registered?.registration.name).toBe("summary-tool");
      expect(result.doctor.ok).toBe(true);
      expect(status.agent).toBe("tool-builder");
      expect(status.status).toBe("completed");
      expect(transcript.messages.map((message) => message.type)).toEqual(["delegate", "accept", "result"]);
    });
  });

  it("times out running subagents and records structured status", async () => {
    await withTempWorkspace(async (root) => {
      const script = path.join(root, "slow-tool.mjs");
      await writeFile(script, "setTimeout(() => console.log(JSON.stringify({ ok: true })), 1000); process.stdin.resume();", "utf8");
      await addTool(await writeJson(root, "tool.json", fakeToolRegistration({
        name: "slow-tool",
        discovery: {
          strategy: "static",
          a2c2a: {
            command: process.execPath,
            args: [script]
          }
        }
      })), root);
      await addTask(await writeJson(root, "task.json", {
        name: "slow-task",
        goal: "Run slowly.",
        steps: [{ name: "slow", tool: "slow-tool", action: "run", input: {} }]
      }), root);
      await addAgentProfile(await writeJson(root, "agent.json", {
        schema: "cyborg.agent-profile.v0.1",
        name: "sprinter",
        allowed_tools: ["slow-tool"],
        allowed_tasks: ["slow-task"],
        timeout_ms: 100
      }), root);

      await expect(runSubagent("sprinter", "slow-task", root)).rejects.toThrow("timed out");
      const runs = await import("../src/session.js").then(({ listRuns }) => listRuns(root, "agent-sprinter"));
      const runDir = path.dirname(runs[0]?.file ?? "");
      const status = await loadSubagentStatus(path.join(runDir, "subagent-status.json"));
      const transcript = await loadA2ATranscript(path.join(runDir, "a2a.json"));

      expect(status.status).toBe("failed");
      expect(status.error?.code).toBe("subagent_timeout");
      expect(transcript.messages.at(-1)?.type).toBe("error");
      expect((await readAuditEvents(root)).map((event) => event.type)).toContain("subagent.error");
    });
  });
});
