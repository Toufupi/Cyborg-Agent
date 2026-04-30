import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  appendA2AMessage,
  createA2AConversationId,
  createA2AMessage,
  createA2ATranscript,
  saveA2ATranscript,
  transcriptPath
} from "./a2a.js";
import { loadTask } from "./task.js";
import { emitSessionEvent } from "./hooks.js";
import { createSession, saveSession, type CyborgSession } from "./session.js";
import { runTask } from "./agent/task-runner.js";
import { runAgentGoal } from "./agent/planner.js";
import { assertPolicyDecision, checkTask, checkTool, loadPolicy } from "./policy.js";

export const AgentProfileSchema = z.object({
  schema: z.literal("cyborg.agent-profile.v0.1").default("cyborg.agent-profile.v0.1"),
  name: z.string().min(1).regex(/^[a-z][a-z0-9-]*$/),
  description: z.string().max(240).optional(),
  model_profile: z.enum(["small", "large", "auto", "manual"]).default("auto"),
  policy: z.string().min(1).optional(),
  allowed_tools: z.array(z.string().min(1)).default([]),
  allowed_tasks: z.array(z.string().min(1)).default([]),
  instructions: z.string().max(4000).optional()
});

export type AgentProfile = z.output<typeof AgentProfileSchema>;

export const SubagentStatusSchema = z.object({
  schema: z.literal("cyborg.subagent-status.v0.1"),
  run_id: z.string().min(1),
  agent: z.string().min(1),
  task: z.string().min(1),
  status: z.enum(["starting", "running", "completed", "failed", "cancelled"]),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  parent_session_id: z.string().min(1).optional(),
  task_run: z.string().optional(),
  a2a_transcript: z.string().optional(),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1)
  }).optional()
});

export type SubagentStatus = z.output<typeof SubagentStatusSchema>;

export function agentsDir(root = process.cwd()) {
  return path.join(path.resolve(root), ".cyborg", "agents");
}

export function agentPath(name: string, root = process.cwd()) {
  return path.join(agentsDir(root), `${name}.json`);
}

export async function addAgentProfile(file: string, root = process.cwd()) {
  const raw = await readFile(path.resolve(file), "utf8");
  const profile = file.toLowerCase().endsWith(".md")
    ? parseAgentMarkdown(raw)
    : AgentProfileSchema.parse(JSON.parse(raw));
  const dir = agentsDir(root);
  const output = agentPath(profile.name, root);
  await mkdir(dir, { recursive: true });
  await writeFile(output, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  return { output, profile };
}

export async function loadAgentProfile(name: string, root = process.cwd()) {
  return AgentProfileSchema.parse(JSON.parse(await readFile(agentPath(name, root), "utf8")));
}

export async function listAgentProfiles(root = process.cwd()) {
  const dir = agentsDir(root);
  try {
    const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
    return Promise.all(files.map(async (file) => {
      const profile = AgentProfileSchema.parse(JSON.parse(await readFile(path.join(dir, file), "utf8")));
      return { file: path.join(dir, file), profile };
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function runSubagent(profileName: string, taskName: string, root = process.cwd(), options: { worker?: "task" | "planner" } = {}) {
  const profile = await loadAgentProfile(profileName, root);
  const task = await loadTask(taskName, root);
  assertProfileAllowsTask(profile, taskName);
  assertProfileAllowsTools(profile, task.steps.map((step) => step.tool));
  const policy = await loadPolicy(profile.policy ?? "default", root);
  assertPolicyDecision(checkTask(policy, taskName));
  for (const tool of task.steps.map((step) => step.tool)) {
    assertPolicyDecision(checkTool(policy, tool));
  }

  const session = await createSession(root, `agent-${profile.name}`);
  let status = await saveSubagentStatus(session, createSubagentStatus(session, profile.name, task.name));
  const conversationId = createA2AConversationId(`a2a-${profile.name}`);
  const transcript = createA2ATranscript(conversationId);
  const parent = { agent: "cyborg", session_id: session.id };
  const child = { agent: profile.name };
  const delegate = appendA2AMessage(transcript, createA2AMessage({
    conversationId,
    from: parent,
    to: child,
    type: "delegate",
    task: task.name,
    content: task.goal,
    data: {
      profile: profile.name,
      model_profile: profile.model_profile,
      policy: policy.name,
      allowed_tools: profile.allowed_tools,
      allowed_tasks: profile.allowed_tasks,
      instructions: profile.instructions
    }
  }));
  appendA2AMessage(transcript, createA2AMessage({
    conversationId,
    parentId: delegate.id,
    from: child,
    to: parent,
    type: "accept",
    task: task.name,
    content: `Accepted task ${task.name}.`
  }));
  await saveA2ATranscript(session, transcript);

  await emitSessionEvent(root, session, "subagent.start", `Started subagent ${profile.name}`, {
    profile,
    task,
    a2a: {
      conversation_id: conversationId,
      transcript: transcriptPath(session)
    }
  });
  try {
    status = await saveSubagentStatus(session, {
      ...status.status,
      status: "running",
      updated_at: new Date().toISOString(),
      a2a_transcript: transcriptPath(session)
    });
    const workerMode = options.worker ?? "task";
    const taskRun = workerMode === "planner"
      ? await runAgentGoal([
        profile.instructions,
        `Task: ${task.name}`,
        `Goal: ${task.goal}`,
        `Allowed tools: ${profile.allowed_tools.join(", ") || "profile default"}`
      ].filter(Boolean).join("\n"), root)
      : await runTask(taskName, root, {
        parentSessionId: session.id,
        agent: profile.name,
        policy
      });
    appendA2AMessage(transcript, createA2AMessage({
      conversationId,
      from: child,
      to: parent,
      type: "result",
      task: task.name,
      content: `Finished task ${task.name}.`,
      data: {
        taskRun: taskRun.file
      }
    }));
    const saved = await saveA2ATranscript(session, transcript);
    status = await saveSubagentStatus(session, {
      ...status.status,
      status: "completed",
      updated_at: new Date().toISOString(),
      task_run: taskRun.file,
      a2a_transcript: saved.file
    });
    await emitSessionEvent(root, session, "subagent.end", `Finished subagent ${profile.name}`, {
      taskRun: taskRun.file,
      status: status.file,
      a2a: {
        conversation_id: conversationId,
        transcript: saved.file
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendA2AMessage(transcript, createA2AMessage({
      conversationId,
      from: child,
      to: parent,
      type: "error",
      task: task.name,
      content: `Failed task ${task.name}.`,
      error: {
        code: "subagent_runtime_error",
        message
      }
    }));
    const saved = await saveA2ATranscript(session, transcript);
    await saveSubagentStatus(session, {
      ...status.status,
      status: "failed",
      updated_at: new Date().toISOString(),
      a2a_transcript: saved.file,
      error: {
        code: "subagent_runtime_error",
        message
      }
    });
    throw error;
  }
  return saveSession(session);
}

export function subagentStatusPath(session: CyborgSession) {
  return path.join(session.runDir, "subagent-status.json");
}

export async function loadSubagentStatus(file: string) {
  return SubagentStatusSchema.parse(JSON.parse(await readFile(path.resolve(file), "utf8")));
}

async function saveSubagentStatus(session: CyborgSession, status: SubagentStatus) {
  const file = subagentStatusPath(session);
  await writeFile(file, `${JSON.stringify(SubagentStatusSchema.parse(status), null, 2)}\n`, "utf8");
  return { file, status };
}

function createSubagentStatus(session: CyborgSession, agent: string, task: string): SubagentStatus {
  const now = new Date().toISOString();
  return {
    schema: "cyborg.subagent-status.v0.1",
    run_id: session.id,
    agent,
    task,
    status: "starting",
    created_at: now,
    updated_at: now,
    parent_session_id: session.id
  };
}

function parseAgentMarkdown(raw: string): AgentProfile {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) {
    throw new Error("Agent Markdown must start with frontmatter delimited by ---.");
  }
  const end = trimmed.indexOf("\n---", 3);
  if (end < 0) {
    throw new Error("Agent Markdown frontmatter must end with ---.");
  }
  const frontmatter = trimmed.slice(3, end).trim();
  const instructions = trimmed.slice(end + 4).trim();
  const fields = parseFrontmatter(frontmatter);
  return AgentProfileSchema.parse({
    schema: "cyborg.agent-profile.v0.1",
    name: requireString(fields, "name"),
    description: optionalString(fields.description),
    model_profile: optionalString(fields.model_profile) ?? "auto",
    policy: optionalString(fields.policy),
    allowed_tools: optionalStringArray(fields.allowed_tools),
    allowed_tasks: optionalStringArray(fields.allowed_tasks),
    instructions
  });
}

function parseFrontmatter(frontmatter: string) {
  const fields: Record<string, unknown> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/.exec(trimmed);
    if (!match) {
      throw new Error(`Invalid agent frontmatter line: ${line}`);
    }
    fields[match[1]] = parseFrontmatterValue(match[2]);
  }
  return fields;
}

function parseFrontmatterValue(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) {
      return [];
    }
    return inner.split(",").map((item) => stripQuotes(item.trim())).filter(Boolean);
  }
  return stripQuotes(trimmed);
}

function stripQuotes(value: string) {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function requireString(fields: Record<string, unknown>, key: string) {
  const value = optionalString(fields[key]);
  if (!value) {
    throw new Error(`Agent Markdown frontmatter field '${key}' is required.`);
  }
  return value;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalStringArray(value: unknown) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("Agent Markdown array fields must use inline arrays like [a, b].");
  }
  return value;
}

function assertProfileAllowsTask(profile: AgentProfile, taskName: string) {
  if (profile.allowed_tasks.length > 0 && !profile.allowed_tasks.includes(taskName)) {
    throw new Error(`Agent '${profile.name}' is not allowed to run task '${taskName}'.`);
  }
}

function assertProfileAllowsTools(profile: AgentProfile, tools: string[]) {
  if (profile.allowed_tools.length === 0) {
    return;
  }
  const denied = [...new Set(tools)].filter((tool) => !profile.allowed_tools.includes(tool));
  if (denied.length > 0) {
    throw new Error(`Agent '${profile.name}' is not allowed to use tools: ${denied.join(", ")}.`);
  }
}
