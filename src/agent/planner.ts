import { readFile } from "node:fs/promises";
import { z } from "zod";
import { chooseModel } from "../model-router.js";
import { loadConfig } from "../config.js";
import { getTool, listTools } from "../registry.js";
import { runInvocation } from "../runner.js";
import { cyborgEnv } from "../runtime.js";
import { addEvent, createSession, listRuns, saveSession } from "../session.js";
import { listTasks } from "../task.js";
import { prepareToolEnv, prepareToolInvocation } from "../tool-runtime.js";
import type { JsonValue } from "../types.js";
import { completeJsonWithOptionalUsage, OpenAICompatibleModelClient, serializeModelError, type ModelClient, type ModelUsage } from "../model-client.js";
import { runToolBuilderSubagent } from "../agents.js";
import { addMemory, memoryContext, searchMemories } from "../memory.js";
import { buildToolIndex } from "./tool-context.js";
import { runTask } from "./task-runner.js";
import { evaluateAgentState, type AgentStepResult } from "./state-evaluator.js";

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
    kind: z.literal("inspect_run"),
    prefix: z.string().min(1).optional(),
    limit: z.number().int().positive().max(10).default(3),
    reason: z.string().default("")
  }),
  z.object({
    kind: z.literal("create_tool"),
    name: z.string().min(1).regex(/^[a-z][a-z0-9-]*$/),
    description: z.string().max(240).optional(),
    category: z.string().min(1).default("generated"),
    register: z.boolean().default(true),
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
  conversationContext?: JsonValue;
}

export interface AgentAttempt {
  attempt: number;
  model: string;
  plan: AgentPlan;
  ok: boolean;
  code?: number | null;
  error_type?: string;
  usage?: ModelUsage;
}

export interface AgentRunResult {
  session: string;
  file: string;
  output: string;
  plan: AgentPlan;
  attempts: AgentAttempt[];
  steps: AgentAttempt[];
}

export type AgentRunEvent =
  | { type: "agent.start"; session: string; goal: string; model: string }
  | { type: "agent.step.plan"; step: number; plan: AgentPlan; model: string; usage?: ModelUsage }
  | { type: "agent.step.result"; step: number; plan: AgentPlan; result: AgentStepResult }
  | { type: "agent.step.evaluation"; step: number; decision: string; reason: string }
  | { type: "agent.repair"; attempt: number; model: string; plan: AgentPlan; ok: boolean; code?: number | null; error_type?: string; usage?: ModelUsage }
  | { type: "agent.error"; error: ReturnType<typeof serializeModelError> }
  | { type: "agent.usage"; summary: ReturnType<typeof summarizeModelUsage> }
  | { type: "agent.final"; result: AgentRunResult };

export async function* runAgentGoalStream(goal: string, root = process.cwd(), options: AgentRunOptions = {}): AsyncGenerator<AgentRunEvent, AgentRunResult> {
  const session = await createSession(root, "agent");
  const modelClient = options.modelClient ?? new OpenAICompatibleModelClient();
  const maxRepairAttempts = options.maxRepairAttempts ?? 1;
  const maxSteps = options.maxSteps ?? 6;
  const config = await loadConfig(root);
  const smallModel = chooseModel(config, "default");
  const context = await buildPlanningContext(root, goal);

  addEvent(session, "agent.goal", goal, { model: smallModel.model });

  let output = "";
  let finalPlan: AgentPlan = { kind: "final", message: "No final answer produced.", confidence: 0, reason: "max steps not started" };
  const attempts: AgentAttempt[] = [];
  const stepHistory: AgentAttempt[] = [];
  const observations: JsonValue[] = [];
  const usage: AgentModelUsageEvent[] = [];

  try {
    yield { type: "agent.start", session: session.id, goal, model: smallModel.model };
    for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
      const requested = await requestStep(modelClient, smallModel, goal, context, observations, options.conversationContext);
      const plan = requested.plan;
      usage.push({
        phase: "plan",
        model: smallModel.model,
        role: smallModel.role,
        usage: requested.usage
      });
      finalPlan = plan;
      addEvent(session, "agent.plan", `Step ${stepIndex}: ${plan.kind}`, { step: stepIndex, plan });
      addModelUsageEvent(session, usage.at(-1));
      yield { type: "agent.step.plan", step: stepIndex, plan, model: smallModel.model, usage: requested.usage };

      const repairs: AgentAttempt[] = [];
      const stepResult = await executeAgentStep(plan, {
        root,
        sessionId: session.id,
        context,
        goal,
        modelClient,
        smallModel,
        config,
        maxRepairAttempts,
        attempts,
        usage,
        onRepair: (repair) => {
          repairs.push(repair);
        }
      });
      const evaluation = evaluateAgentState({
        step: stepIndex,
        plan,
        result: stepResult,
        observations
      });
      stepHistory.push({
        attempt: stepIndex,
        model: smallModel.model,
        plan,
        ok: stepResult.ok,
        code: stepResult.code,
        error_type: stepResult.error_type,
        usage: requested.usage
      });
      observations.push({
        step: stepIndex,
        action: toJsonValue(plan),
        observation: toJsonValue(stepResult.observation)
      });
      addEvent(session, "agent.observation", `Step ${stepIndex} observation`, stepResult);
      addEvent(session, "agent.evaluation", `Step ${stepIndex} evaluation: ${evaluation.decision}`, evaluation);
      for (const repair of repairs) {
        yield {
          type: "agent.repair",
          attempt: repair.attempt,
          model: repair.model,
          plan: repair.plan,
          ok: repair.ok,
          code: repair.code,
          error_type: repair.error_type,
          usage: repair.usage
        };
      }
      yield { type: "agent.step.result", step: stepIndex, plan, result: stepResult };
      yield { type: "agent.step.evaluation", step: stepIndex, decision: evaluation.decision, reason: evaluation.reason };

      if (evaluation.decision === "final") {
        output = stepResult.output;
        break;
      }
      if (evaluation.decision === "stop") {
        output = JSON.stringify({ ok: false, error: "state_evaluator_stop", evaluation }, null, 2);
        finalPlan = {
          kind: "final",
          message: evaluation.reason,
          confidence: 0,
          reason: "state_evaluator_stop"
        };
        break;
      }
    }
  } catch (error) {
    const modelError = serializeModelError(error);
    finalPlan = {
      kind: "final",
      message: `Agent stopped before completing the goal: ${modelError.message}`,
      confidence: 0,
      reason: modelError.type
    };
    output = JSON.stringify({ ok: false, error: modelError }, null, 2);
    addEvent(session, "agent.error", "Agent run failed.", { error: modelError });
    yield { type: "agent.error", error: modelError };
  }

  if (!output) {
    output = JSON.stringify({ ok: false, error: "max_steps_exceeded", observations }, null, 2);
  }
  const usageSummary = summarizeModelUsage(usage);
  addEvent(session, "agent.usage", "Model usage summary.", usageSummary);
  addEvent(session, "agent.final", "Agent run finished.", { output });
  const saved = await saveSession(session);
  if (output) {
    await rememberAgentRun(root, {
      goal,
      output,
      run: saved.file,
      finalPlan
    });
  }
  const result = { session: session.id, file: saved.file, output, plan: finalPlan, attempts, steps: stepHistory };
  yield { type: "agent.usage", summary: usageSummary };
  yield { type: "agent.final", result };
  return result;
}

export async function runAgentGoal(goal: string, root = process.cwd(), options: AgentRunOptions = {}): Promise<AgentRunResult> {
  const stream = runAgentGoalStream(goal, root, options);
  let next = await stream.next();
  while (!next.done) {
    next = await stream.next();
  }
  return next.value;
}

async function buildPlanningContext(root: string, goal: string) {
  const tools = await buildToolIndex(root);
  const tasks = (await listTasks(root)).map(({ task }) => ({
    name: task.name,
    goal: task.goal,
    tools: task.tools,
    steps: task.steps.map((step) => ({ name: step.name, tool: step.tool, action: step.action }))
  }));
  const memories = memoryContext(await searchMemories(root, { goal, limit: 5 }));
  return { tools, tasks, memories };
}

async function requestStep(
  modelClient: ModelClient,
  model: Parameters<ModelClient["completeJson"]>[0],
  goal: string,
  context: JsonValue,
  observations: JsonValue,
  conversationContext?: JsonValue
) {
  const result = await completeJsonWithOptionalUsage(modelClient, model, [
    { role: "system", content: plannerSystemPrompt() },
    { role: "user", content: JSON.stringify({ goal, context, observations, conversation: conversationContext }, null, 2) }
  ]);
  return {
    plan: AgentPlanSchema.parse(result.json),
    usage: result.usage
  };
}

async function requestRepair(
  modelClient: ModelClient,
  model: Parameters<ModelClient["completeJson"]>[0],
  goal: string,
  context: JsonValue,
  failedPlan: AgentPlan,
  errorText: string
) {
  const result = await completeJsonWithOptionalUsage(modelClient, model, [
    { role: "system", content: repairSystemPrompt() },
    { role: "user", content: JSON.stringify({ goal, context, failed_plan: failedPlan, tool_error: safeJson(errorText) }, null, 2) }
  ]);
  return {
    plan: AgentPlanSchema.parse(result.json),
    usage: result.usage
  };
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
    usage: AgentModelUsageEvent[];
    onRepair?: (attempt: AgentAttempt) => void;
  }
): Promise<AgentStepResult> {
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
  if (plan.kind === "inspect_run") {
    const runs = await listRuns(state.root, plan.prefix);
    return {
      ok: true,
      done: false,
      output: "",
      observation: {
        runs: runs.slice(0, plan.limit).map((run) => ({
          id: run.id,
          file: run.file,
          event_count: Array.isArray((run.run as { events?: unknown[] }).events)
            ? (run.run as { events: unknown[] }).events.length
            : 0
        }))
      } satisfies JsonValue
    };
  }
  if (plan.kind === "create_tool") {
    const built = await runToolBuilderSubagent(state.root, {
      name: plan.name,
      description: plan.description,
      category: plan.category,
      register: plan.register,
      parentSessionId: state.sessionId
    });
    return {
      ok: true,
      done: false,
      output: "",
      observation: {
        toolRoot: built.toolRoot,
        registrationFile: built.registrationFile,
        registered: built.registered ? {
          name: built.registered.registration.name,
          output: built.registered.output
        } : null,
        doctor: toJsonValue(built.doctor),
        run: built.run,
        a2a: built.a2a
      } satisfies JsonValue
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
    const repaired = await requestRepair(state.modelClient, repairModel, state.goal, state.context, plan, lastResult.body);
    const repairPlan = repaired.plan;
    state.usage.push({
      phase: "repair",
      model: repairModel.model,
      role: repairModel.role,
      usage: repaired.usage
    });
    if (repairPlan.kind !== "call_tool") {
      const message = repairPlan.kind === "answer" || repairPlan.kind === "final" ? repairPlan.message : JSON.stringify(repairPlan);
      state.attempts.push({ attempt, model: repairModel.model, plan: repairPlan, ok: true, usage: repaired.usage });
      state.onRepair?.(state.attempts.at(-1)!);
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
      error_type: extractErrorType(lastResult.body),
      usage: repaired.usage
    });
    state.onRepair?.(state.attempts.at(-1)!);
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
    "{\"kind\":\"inspect_run\",\"prefix\":\"optional-prefix\",\"limit\":3,\"reason\":\"short\"}",
    "{\"kind\":\"create_tool\",\"name\":\"semantic-tool-name\",\"description\":\"short\",\"category\":\"general\",\"register\":true,\"reason\":\"short\"}",
    "{\"kind\":\"run_task\",\"task\":\"name\",\"confidence\":0.0,\"reason\":\"short\"}",
    "{\"kind\":\"call_tool\",\"tool\":\"name\",\"request\":{\"a2c2a\":\"0.1\",\"action\":\"domain.action\",\"input\":{},\"meta\":{}},\"confidence\":0.0,\"reason\":\"short\"}",
    "{\"kind\":\"answer\",\"message\":\"short answer\",\"confidence\":0.0,\"reason\":\"short\"}",
    "{\"kind\":\"final\",\"message\":\"final answer\",\"confidence\":0.0,\"reason\":\"short\"}",
    "Inspect a tool manifest before calling it if the action/input contract is unclear.",
    "Use create_tool only when no registered tool or task can satisfy a repeatable capability.",
    "Prefer registered tasks for recurring goals. Prefer call_tool when a tool directly solves the goal.",
    "Use only tools and tasks listed in context.",
    "Do not introduce installed tools or demo tasks unless the user asks for capabilities, tools, tasks, or a matching goal."
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

interface AgentModelUsageEvent {
  phase: "plan" | "repair";
  model: string;
  role: "small" | "large";
  usage?: ModelUsage;
}

function addModelUsageEvent(session: Parameters<typeof addEvent>[0], event: AgentModelUsageEvent | undefined) {
  if (!event) {
    return;
  }
  addEvent(session, "agent.model", `Model ${event.model} ${event.phase}`, event);
}

function summarizeModelUsage(events: AgentModelUsageEvent[]) {
  const summary = {
    calls: events.length,
    small: emptyUsageBucket(),
    large: emptyUsageBucket(),
    by_model: {} as Record<string, ReturnType<typeof emptyUsageBucket>>
  };
  for (const event of events) {
    addUsage(summary[event.role], event.usage);
    summary.by_model[event.model] ??= emptyUsageBucket();
    addUsage(summary.by_model[event.model], event.usage);
  }
  return summary;
}

function emptyUsageBucket() {
  return {
    calls: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0
  };
}

function addUsage(bucket: ReturnType<typeof emptyUsageBucket>, usage?: ModelUsage) {
  bucket.calls += 1;
  bucket.prompt_tokens += usage?.prompt_tokens ?? 0;
  bucket.completion_tokens += usage?.completion_tokens ?? 0;
  bucket.total_tokens += usage?.total_tokens ?? 0;
}

async function rememberAgentRun(root: string, input: { goal: string; output: string; run: string; finalPlan: AgentPlan }) {
  if (isCapabilityChat(input.goal, input.output)) {
    return;
  }
  const ok = !input.output.includes("\"ok\": false");
  await addMemory(root, {
    type: "run_memory",
    title: ok ? `Completed goal: ${input.goal.slice(0, 96)}` : `Failed goal: ${input.goal.slice(0, 96)}`,
    summary: summarizeOutput(input.output),
    tags: ["agent-run", ok ? "success" : "failure", input.finalPlan.kind],
    task: input.finalPlan.kind === "run_task" ? input.finalPlan.task : undefined,
    tool: input.finalPlan.kind === "call_tool" ? input.finalPlan.tool : undefined,
    source_run: input.run,
    data: {
      goal: input.goal,
      final_plan: input.finalPlan,
      ok
    }
  });
}

function isCapabilityChat(goal: string, output: string) {
  const text = `${goal}\n${output}`.toLowerCase();
  return [
    "what can you do",
    "what are your capabilities",
    "\u4f60\u80fd\u505a\u4ec0\u4e48",
    "\u4f60\u53ef\u4ee5\u505a\u4ec0\u4e48",
    "\u6709\u4ec0\u4e48\u80fd\u529b"
  ].some((phrase) => text.includes(phrase))
    || (text.includes("page-generator-cli") && text.includes("research-fetcher"));
}

function summarizeOutput(output: string) {
  const compact = output.replace(/\s+/g, " ").trim();
  return compact.length > 600 ? `${compact.slice(0, 597)}...` : compact;
}
