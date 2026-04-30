import { readFile } from "node:fs/promises";
import { z } from "zod";
import { chooseModel } from "../model-router.js";
import { loadConfig } from "../config.js";
import { getTool, listTools } from "../registry.js";
import { runInvocation } from "../runner.js";
import { cyborgEnv } from "../runtime.js";
import { addEvent, createSession, saveSession } from "../session.js";
import { listTasks } from "../task.js";
import { prepareToolEnv, prepareToolInvocation } from "../tool-runtime.js";
import type { JsonValue } from "../types.js";
import { OpenAICompatibleModelClient, type ModelClient } from "../model-client.js";
import { buildToolIndex } from "./tool-context.js";
import { runTask } from "./task-runner.js";

const A2C2ARequestSchema = z.object({
  a2c2a: z.string().default("0.1"),
  action: z.string().min(1),
  input: z.unknown().default({}),
  meta: z.record(z.string(), z.unknown()).optional()
});

const AgentPlanSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("run_task"),
    task: z.string().min(1),
    confidence: z.number().min(0).max(1).default(0.7),
    reason: z.string().default("")
  }),
  z.object({
    kind: z.literal("call_tool"),
    tool: z.string().min(1),
    request: A2C2ARequestSchema,
    confidence: z.number().min(0).max(1).default(0.7),
    reason: z.string().default("")
  }),
  z.object({
    kind: z.literal("answer"),
    message: z.string().min(1),
    confidence: z.number().min(0).max(1).default(0.5),
    reason: z.string().default("")
  })
]);

export type AgentPlan = z.output<typeof AgentPlanSchema>;

export interface AgentRunOptions {
  maxRepairAttempts?: number;
  modelClient?: ModelClient;
}

export interface AgentAttempt {
  attempt: number;
  model: string;
  plan: AgentPlan;
  ok: boolean;
  code?: number | null;
  error_type?: string;
}

export interface AgentRunResult {
  session: string;
  file: string;
  output: string;
  plan: AgentPlan;
  attempts: AgentAttempt[];
}

export async function runAgentGoal(goal: string, root = process.cwd(), options: AgentRunOptions = {}): Promise<AgentRunResult> {
  const session = await createSession(root, "agent");
  const modelClient = options.modelClient ?? new OpenAICompatibleModelClient();
  const maxRepairAttempts = options.maxRepairAttempts ?? 1;
  const config = await loadConfig(root);
  const smallModel = chooseModel(config, "default");
  const context = await buildPlanningContext(root);

  addEvent(session, "agent.goal", goal, { model: smallModel.model });
  const plan = await requestPlan(modelClient, smallModel, goal, context);
  addEvent(session, "agent.plan", `Plan: ${plan.kind}`, plan);

  let output = "";
  let finalPlan = plan;
  const attempts: AgentAttempt[] = [];

  if (plan.kind === "answer") {
    output = plan.message;
  } else if (plan.kind === "run_task") {
    const result = await runTask(plan.task, root, { parentSessionId: session.id, agent: "cyborg" });
    output = JSON.stringify({ ok: true, run: result.file }, null, 2);
    addEvent(session, "agent.task_result", `Ran task ${plan.task}`, result);
  } else {
    const result = await callToolWithRequest(plan.tool, plan.request, root, session.id);
    attempts.push({
      attempt: 0,
      model: smallModel.model,
      plan,
      ok: result.ok,
      code: result.code,
      error_type: extractErrorType(result.body)
    });
    addEvent(session, result.ok ? "agent.tool_ok" : "agent.tool_error", `Called tool ${plan.tool}`, result);
    if (result.ok) {
      output = result.body;
    } else {
      let repaired = false;
      let lastResult = result;
      for (let attempt = 1; attempt <= maxRepairAttempts; attempt += 1) {
        const fallback = shouldFallback(config, lastResult.body, attempt);
        const repairModel = fallback ? chooseModel(config, "repair_failed") : smallModel;
        const repairPlan = await requestRepair(modelClient, repairModel, goal, context, finalPlan, lastResult.body);
        finalPlan = repairPlan;
        addEvent(session, fallback ? "agent.fallback" : "agent.repair_plan", `Repair attempt ${attempt}`, {
          model: repairModel.model,
          plan: repairPlan,
          previous_error_type: extractErrorType(lastResult.body)
        });
        if (repairPlan.kind !== "call_tool") {
          output = repairPlan.kind === "answer" ? repairPlan.message : JSON.stringify(repairPlan, null, 2);
          attempts.push({
            attempt,
            model: repairModel.model,
            plan: repairPlan,
            ok: true
          });
          repaired = true;
          break;
        }
        lastResult = await callToolWithRequest(repairPlan.tool, repairPlan.request, root, session.id);
        attempts.push({
          attempt,
          model: repairModel.model,
          plan: repairPlan,
          ok: lastResult.ok,
          code: lastResult.code,
          error_type: extractErrorType(lastResult.body)
        });
        addEvent(session, lastResult.ok ? "agent.tool_ok" : "agent.tool_error", `Repair call ${attempt}`, lastResult);
        if (lastResult.ok) {
          output = lastResult.body;
          repaired = true;
          break;
        }
      }
      if (!repaired) {
        output = lastResult.body;
      }
    }
  }

  addEvent(session, "agent.final", "Agent run finished.", { output });
  const saved = await saveSession(session);
  return { session: session.id, file: saved.file, output, plan: finalPlan, attempts };
}

async function buildPlanningContext(root: string) {
  const tools = await buildToolIndex(root);
  const tasks = (await listTasks(root)).map(({ task }) => ({
    name: task.name,
    goal: task.goal,
    tools: task.tools,
    steps: task.steps.map((step) => ({ name: step.name, tool: step.tool, action: step.action }))
  }));
  return { tools, tasks };
}

async function requestPlan(modelClient: ModelClient, model: Parameters<ModelClient["completeJson"]>[0], goal: string, context: JsonValue) {
  const raw = await modelClient.completeJson(model, [
    { role: "system", content: plannerSystemPrompt() },
    { role: "user", content: JSON.stringify({ goal, context }, null, 2) }
  ]);
  return AgentPlanSchema.parse(raw);
}

async function requestRepair(
  modelClient: ModelClient,
  model: Parameters<ModelClient["completeJson"]>[0],
  goal: string,
  context: JsonValue,
  failedPlan: AgentPlan,
  errorText: string
) {
  const raw = await modelClient.completeJson(model, [
    { role: "system", content: repairSystemPrompt() },
    { role: "user", content: JSON.stringify({ goal, context, failed_plan: failedPlan, tool_error: safeJson(errorText) }, null, 2) }
  ]);
  return AgentPlanSchema.parse(raw);
}

async function callToolWithRequest(toolName: string, request: z.output<typeof A2C2ARequestSchema>, root: string, sessionId: string) {
  const { registration } = await getTool(toolName, root);
  const invocation = registration.discovery.a2c2a ?? registration.protocols?.find((protocol) => protocol.name === "a2c2a")?.invocation;
  if (!invocation) {
    throw new Error(`Tool '${toolName}' has no A2C2A invocation.`);
  }
  const result = await runInvocation(prepareToolInvocation(registration, invocation, root), {
    input: `${JSON.stringify(request)}\n`,
    env: prepareToolEnv(registration, cyborgEnv(root, sessionId), root),
    cwd: root
  });
  const body = result.stdout.trim() || result.stderr.trim();
  return {
    ok: result.code === 0 && responseOk(body),
    code: result.code,
    body
  };
}

export async function readRequestFile(file: string) {
  return A2C2ARequestSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

function plannerSystemPrompt() {
  return [
    "You are Cyborg-Agent's small-model planner.",
    "Return exactly one JSON object. No markdown.",
    "Choose one plan kind:",
    "{\"kind\":\"run_task\",\"task\":\"name\",\"confidence\":0.0,\"reason\":\"short\"}",
    "{\"kind\":\"call_tool\",\"tool\":\"name\",\"request\":{\"a2c2a\":\"0.1\",\"action\":\"domain.action\",\"input\":{},\"meta\":{}},\"confidence\":0.0,\"reason\":\"short\"}",
    "{\"kind\":\"answer\",\"message\":\"short answer\",\"confidence\":0.0,\"reason\":\"short\"}",
    "Prefer registered tasks for recurring goals. Prefer call_tool when a tool directly solves the goal.",
    "Use only tools and tasks listed in context."
  ].join("\n");
}

function repairSystemPrompt() {
  return [
    "You repair failed Cyborg-Agent tool calls.",
    "Return exactly one JSON object. No markdown.",
    "If the tool returned A2C2A validation issues, fix the request paths and retry with kind call_tool.",
    "If the goal cannot be safely completed, return kind answer with a concise explanation.",
    "Use only tools listed in context."
  ].join("\n");
}

function shouldFallback(config: Awaited<ReturnType<typeof loadConfig>>, body: string, attempt: number) {
  if (!config.models.large || config.models.routing.mode !== "auto") {
    return false;
  }
  const errorType = extractErrorType(body);
  if (attempt > 1 && config.models.routing.fallback_on.includes("max_retries_exceeded")) {
    return true;
  }
  return config.models.routing.fallback_on.some((reason) => body.includes(reason) || errorType === reason);
}

function responseOk(body: string) {
  const parsed = safeJson(body);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && parsed.ok === true;
}

function safeJson(value: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
}

function extractErrorType(body: string) {
  const parsed = safeJson(body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const error = parsed.error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return undefined;
  }
  return typeof error.type === "string" ? error.type : undefined;
}
