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

const AgentStepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("inspect_context"),
    reason: z.string().default("")
  }),
  z.object({
    kind: z.literal("inspect_tool"),
    tool: z.string().min(1),
    include: z.enum(["help", "manifest", "both"]).default("manifest"),
    reason: z.string().default("")
  }),
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
  }),
  z.object({
    kind: z.literal("final"),
    message: z.string().min(1),
    confidence: z.number().min(0).max(1).default(0.5),
    reason: z.string().default("")
  })
]);

const AgentPlanSchema = AgentStepSchema;

export type AgentPlan = z.output<typeof AgentPlanSchema>;
export type AgentStep = AgentPlan;

export interface AgentRunOptions {
  maxRepairAttempts?: number;
  maxSteps?: number;
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
  steps: AgentAttempt[];
}

export async function runAgentGoal(goal: string, root = process.cwd(), options: AgentRunOptions = {}): Promise<AgentRunResult> {
  const session = await createSession(root, "agent");
  const modelClient = options.modelClient ?? new OpenAICompatibleModelClient();
  const maxRepairAttempts = options.maxRepairAttempts ?? 1;
  const maxSteps = options.maxSteps ?? 6;
  const config = await loadConfig(root);
  const smallModel = chooseModel(config, "default");
  const context = await buildPlanningContext(root);

  addEvent(session, "agent.goal", goal, { model: smallModel.model });

  let output = "";
  let finalPlan: AgentPlan = { kind: "final", message: "No final answer produced.", confidence: 0, reason: "max steps not started" };
  const attempts: AgentAttempt[] = [];
  const stepHistory: AgentAttempt[] = [];
  const observations: JsonValue[] = [];

  for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
    const plan = await requestStep(modelClient, smallModel, goal, context, observations);
    finalPlan = plan;
    addEvent(session, "agent.plan", `Step ${stepIndex}: ${plan.kind}`, { step: stepIndex, plan });

    const stepResult = await executeAgentStep(plan, {
      root,
      sessionId: session.id,
      context,
      goal,
      modelClient,
      smallModel,
      config,
      maxRepairAttempts,
      attempts
    });
    stepHistory.push({
      attempt: stepIndex,
      model: smallModel.model,
      plan,
      ok: stepResult.ok,
      code: stepResult.code,
      error_type: stepResult.error_type
    });
    observations.push({
      step: stepIndex,
      action: toJsonValue(plan),
      observation: toJsonValue(stepResult.observation)
    });
    addEvent(session, "agent.observation", `Step ${stepIndex} observation`, stepResult);

    if (stepResult.done) {
      output = stepResult.output;
      break;
    }
  }

  if (!output) {
    output = JSON.stringify({ ok: false, error: "max_steps_exceeded", observations }, null, 2);
  }
  addEvent(session, "agent.final", "Agent run finished.", { output });
  const saved = await saveSession(session);
  return { session: session.id, file: saved.file, output, plan: finalPlan, attempts, steps: stepHistory };
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

async function requestStep(
  modelClient: ModelClient,
  model: Parameters<ModelClient["completeJson"]>[0],
  goal: string,
  context: JsonValue,
  observations: JsonValue
) {
  const raw = await modelClient.completeJson(model, [
    { role: "system", content: plannerSystemPrompt() },
    { role: "user", content: JSON.stringify({ goal, context, observations }, null, 2) }
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

async function executeAgentStep(
  plan: AgentStep,
  state: {
    root: string;
    sessionId: string;
    context: JsonValue;
    goal: string;
    modelClient: ModelClient;
    smallModel: Parameters<ModelClient["completeJson"]>[0];
    config: Awaited<ReturnType<typeof loadConfig>>;
    maxRepairAttempts: number;
    attempts: AgentAttempt[];
  }
) {
  if (plan.kind === "inspect_context") {
    return {
      ok: true,
      done: false,
      output: "",
      observation: state.context
    };
  }
  if (plan.kind === "inspect_tool") {
    const observation = await inspectTool(plan.tool, plan.include, state.root);
    return {
      ok: true,
      done: false,
      output: "",
      observation
    };
  }
  if (plan.kind === "answer" || plan.kind === "final") {
    return {
      ok: true,
      done: true,
      output: plan.message,
      observation: { message: plan.message } satisfies JsonValue
    };
  }
  if (plan.kind === "run_task") {
    const result = await runTask(plan.task, state.root, { parentSessionId: state.sessionId, agent: "cyborg" });
    const output = JSON.stringify({ ok: true, run: result.file }, null, 2);
    return {
      ok: true,
      done: true,
      output,
      observation: { ok: true, run: result.file } satisfies JsonValue
    };
  }

  const result = await callToolWithRequest(plan.tool, plan.request, state.root, state.sessionId);
  state.attempts.push({
    attempt: 0,
    model: state.smallModel.model,
    plan,
    ok: result.ok,
    code: result.code,
    error_type: extractErrorType(result.body)
  });
  if (result.ok) {
    return {
      ok: true,
      done: false,
      output: result.body,
      code: result.code,
      observation: safeJson(result.body)
    };
  }

  let lastResult = result;
  let finalObservation: JsonValue = safeJson(lastResult.body);
  for (let attempt = 1; attempt <= state.maxRepairAttempts; attempt += 1) {
    const fallback = shouldFallback(state.config, lastResult.body, attempt);
    const repairModel = fallback ? chooseModel(state.config, "repair_failed") : state.smallModel;
    const repairPlan = await requestRepair(state.modelClient, repairModel, state.goal, state.context, plan, lastResult.body);
    if (repairPlan.kind !== "call_tool") {
      const message = repairPlan.kind === "answer" || repairPlan.kind === "final" ? repairPlan.message : JSON.stringify(repairPlan);
      state.attempts.push({ attempt, model: repairModel.model, plan: repairPlan, ok: true });
      return { ok: true, done: true, output: message, observation: { message } satisfies JsonValue };
    }
    lastResult = await callToolWithRequest(repairPlan.tool, repairPlan.request, state.root, state.sessionId);
    finalObservation = safeJson(lastResult.body);
    state.attempts.push({
      attempt,
      model: repairModel.model,
      plan: repairPlan,
      ok: lastResult.ok,
      code: lastResult.code,
      error_type: extractErrorType(lastResult.body)
    });
    if (lastResult.ok) {
      return {
        ok: true,
        done: false,
        output: lastResult.body,
        code: lastResult.code,
        observation: finalObservation
      };
    }
  }
  return {
    ok: false,
    done: false,
    output: lastResult.body,
    code: lastResult.code,
    error_type: extractErrorType(lastResult.body),
    observation: finalObservation
  };
}

async function inspectTool(toolName: string, include: "help" | "manifest" | "both", root: string): Promise<JsonValue> {
  const { registration } = await getTool(toolName, root);
  const result: Record<string, JsonValue> = {
    registration: JSON.parse(JSON.stringify(registration)) as JsonValue
  };
  if ((include === "help" || include === "both") && registration.discovery.help) {
    const help = await runInvocation(prepareToolInvocation(registration, registration.discovery.help, root), {
      env: prepareToolEnv(registration, {}, root),
      cwd: root
    });
    result.help = {
      code: help.code,
      stdout: help.stdout.slice(0, 8000),
      stderr: help.stderr.slice(0, 2000)
    };
  }
  if ((include === "manifest" || include === "both") && registration.discovery.manifest) {
    const manifest = await runInvocation(prepareToolInvocation(registration, registration.discovery.manifest, root), {
      env: prepareToolEnv(registration, {}, root),
      cwd: root
    });
    result.manifest = safeJson(manifest.stdout.trim() || manifest.stderr.trim());
  }
  return result as JsonValue;
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
    "Choose one step kind:",
    "{\"kind\":\"inspect_context\",\"reason\":\"short\"}",
    "{\"kind\":\"inspect_tool\",\"tool\":\"name\",\"include\":\"manifest\",\"reason\":\"short\"}",
    "{\"kind\":\"run_task\",\"task\":\"name\",\"confidence\":0.0,\"reason\":\"short\"}",
    "{\"kind\":\"call_tool\",\"tool\":\"name\",\"request\":{\"a2c2a\":\"0.1\",\"action\":\"domain.action\",\"input\":{},\"meta\":{}},\"confidence\":0.0,\"reason\":\"short\"}",
    "{\"kind\":\"answer\",\"message\":\"short answer\",\"confidence\":0.0,\"reason\":\"short\"}",
    "{\"kind\":\"final\",\"message\":\"final answer\",\"confidence\":0.0,\"reason\":\"short\"}",
    "Inspect a tool manifest before calling it if the action/input contract is unclear.",
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

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
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
