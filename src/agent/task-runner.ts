import { readFile } from "node:fs/promises";
import { getTool } from "../registry.js";
import { runInvocation } from "../runner.js";
import { cyborgEnv } from "../runtime.js";
import { createSession, saveSession } from "../session.js";
import { loadTask } from "../task.js";
import { emitSessionEvent } from "../hooks.js";
import { assertPolicyDecision, checkTool, type CyborgPolicy } from "../policy.js";
import { prepareToolEnv, prepareToolInvocation } from "../tool-runtime.js";

export interface TaskRunOptions {
  parentSessionId?: string;
  agent?: string;
  policy?: CyborgPolicy;
  signal?: AbortSignal;
  onProgress?: (progress: {
    phase: "starting" | "step" | "completed";
    current_step?: string;
    completed_steps: number;
    total_steps: number;
  }) => void | Promise<void>;
}

export async function runTask(name: string, root = process.cwd(), options: TaskRunOptions = {}) {
  const task = await loadTask(name, root);
  const session = await createSession(root, task.name);
  const env = cyborgEnv(root, session.id);
  throwIfAborted(options.signal);
  await options.onProgress?.({
    phase: "starting",
    completed_steps: 0,
    total_steps: task.steps.length
  });
  await emitSessionEvent(root, session, "task.start", `Started task ${task.name}`, {
    task,
    parentSessionId: options.parentSessionId,
    agent: options.agent
  });

  let previousResult: unknown;
  for (const [index, step] of task.steps.entries()) {
    throwIfAborted(options.signal);
    await options.onProgress?.({
      phase: "step",
      current_step: step.name,
      completed_steps: index,
      total_steps: task.steps.length
    });
    await emitSessionEvent(root, session, "step.start", `Running ${step.name}`, step);
    if (options.policy) {
      const decision = checkTool(options.policy, step.tool);
      await emitSessionEvent(root, session, decision.allowed ? "policy.allow" : "policy.deny", `Policy checked tool ${step.tool}`, decision);
      assertPolicyDecision(decision);
    }
    const { registration } = await getTool(step.tool, root);
    const invocation = registration.discovery.a2c2a;
    if (!invocation) {
      await emitSessionEvent(root, session, "step.error", `Tool ${step.tool} has no A2C2A invocation.`);
      continue;
    }
    const preparedInvocation = prepareToolInvocation(registration, invocation, root);
    const stepInput = step.inputFromPrevious ? previousResult ?? step.input : step.input;
    const request = {
      a2c2a: "0.1",
      action: step.action,
      input: stepInput,
      meta: {
        request_id: `${session.id}-${step.name}`
      }
    };
    const result = await runInvocation(preparedInvocation, {
      input: `${JSON.stringify(request)}\n`,
      env: prepareToolEnv(registration, env, root),
      cwd: root,
      workspaceRoot: root,
      policy: options.policy,
      signal: options.signal,
      requester: {
        agent: options.agent,
        session_id: session.id
      }
    });
    await emitSessionEvent(root, session, result.code === 0 ? "step.ok" : "step.failed", `Finished ${step.name}`, {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr
    });
    if (result.code === 0) {
      previousResult = extractA2C2AResult(result.stdout) ?? previousResult;
    }
  }

  throwIfAborted(options.signal);
  await options.onProgress?.({
    phase: "completed",
    completed_steps: task.steps.length,
    total_steps: task.steps.length
  });
  await emitSessionEvent(root, session, "task.end", `Finished task ${task.name}`);
  return saveSession(session);
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error("Task aborted.");
  }
}

function extractA2C2AResult(stdout: string) {
  try {
    const parsed = JSON.parse(stdout) as { ok?: boolean; result?: unknown };
    return parsed.ok ? parsed.result : undefined;
  } catch {
    return undefined;
  }
}

export async function runA2C2ARequest(toolName: string, requestFile: string, root = process.cwd()) {
  const session = await createSession(root, `tool-${toolName}`);
  const env = cyborgEnv(root, session.id);
  const { registration } = await getTool(toolName, root);
  const invocation = registration.discovery.a2c2a;
  if (!invocation) {
    throw new Error(`Tool '${toolName}' has no A2C2A invocation.`);
  }
  const input = await readFile(requestFile, "utf8");
  await emitSessionEvent(root, session, "tool.call", `Calling ${toolName}`, { requestFile });
  const result = await runInvocation(prepareToolInvocation(registration, invocation, root), {
    input,
    env: prepareToolEnv(registration, env, root),
    cwd: root
  });
  await emitSessionEvent(root, session, result.code === 0 ? "tool.ok" : "tool.failed", `Finished ${toolName}`, result);
  await saveSession(session);
  return result;
}
