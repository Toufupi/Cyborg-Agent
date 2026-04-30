import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { completeJsonWithOptionalUsage, OpenAICompatibleModelClient, serializeModelError, type ModelClient, type ModelUsage } from "../model-client.js";
import { chooseModel } from "../model-router.js";
import type { JsonValue } from "../types.js";

const PlannerEvalCaseSchema = z.object({
  schema: z.literal("cyborg.planner-eval.v0.1").default("cyborg.planner-eval.v0.1"),
  name: z.string().min(1),
  description: z.string().optional(),
  goal: z.string().min(1),
  context: z.record(z.string(), z.unknown()).default({}),
  observations: z.array(z.unknown()).default([]),
  expect: z.object({
    kind: z.string().min(1),
    tool: z.string().optional(),
    task: z.string().optional(),
    action: z.string().optional(),
    forbid_premature_final: z.boolean().default(true)
  }),
  baseline: z.object({
    label: z.string().default("full-context-agent"),
    prompt_tokens_estimate: z.number().int().nonnegative().optional(),
    context_tokens_estimate: z.number().int().nonnegative().optional()
  }).default({ label: "full-context-agent" })
});

export type PlannerEvalCase = z.output<typeof PlannerEvalCaseSchema>;

export interface PlannerEvalOptions {
  dir?: string;
  live?: boolean;
  modelClient?: ModelClient;
  output?: string;
}

export interface PlannerEvalReport {
  ok: boolean;
  cases: number;
  passed: number;
  failed: number;
  metrics: {
    json_valid_rate: number;
    expected_kind_rate: number;
    target_match_rate: number;
    premature_final_count: number;
    hallucinated_reference_count: number;
  };
  usage: {
    calls: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    baseline_prompt_tokens_estimate: number;
    estimated_prompt_tokens_saved: number;
    estimated_prompt_saving_rate: number | null;
  };
  results: PlannerEvalResult[];
}

export interface PlannerEvalResult {
  name: string;
  ok: boolean;
  checks: Record<string, boolean>;
  goal: string;
  expected: PlannerEvalCase["expect"];
  plan?: JsonValue;
  error?: ReturnType<typeof serializeModelError>;
  usage?: ModelUsage;
}

export async function runPlannerEval(root = process.cwd(), options: PlannerEvalOptions = {}): Promise<PlannerEvalReport> {
  const dir = path.resolve(root, options.dir ?? "evals/planner");
  const cases = await loadPlannerEvalCases(dir);
  const config = await loadConfig(root);
  const model = chooseModel(config, "default");
  const client = options.modelClient ?? new OpenAICompatibleModelClient();
  const results: PlannerEvalResult[] = [];

  for (const testCase of cases) {
    if (!options.live && !options.modelClient) {
      results.push(evaluatePlan(testCase, testCase.context.expected_plan as JsonValue | undefined));
      continue;
    }
    try {
      const response = await completeJsonWithOptionalUsage(client, model, [
        { role: "system", content: plannerEvalSystemPrompt() },
        {
          role: "user",
          content: JSON.stringify({
            goal: testCase.goal,
            context: testCase.context,
            observations: testCase.observations
          }, null, 2)
        }
      ]);
      results.push(evaluatePlan(testCase, response.json, response.usage));
    } catch (error) {
      results.push({
        name: testCase.name,
        ok: false,
        checks: {
          json_valid: false,
          expected_kind: false,
          target_match: false,
          no_premature_final: false,
          no_hallucinated_reference: false
        },
        goal: testCase.goal,
        expected: testCase.expect,
        error: serializeModelError(error)
      });
    }
  }

  const report = summarizePlannerEval(cases, results);
  if (options.output) {
    await mkdir(path.dirname(path.resolve(root, options.output)), { recursive: true });
    await writeFile(path.resolve(root, options.output), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return report;
}

export async function loadPlannerEvalCases(dir: string) {
  const files = (await readdir(dir))
    .filter((file) => file.endsWith(".json"))
    .sort();
  const cases: PlannerEvalCase[] = [];
  for (const file of files) {
    cases.push(PlannerEvalCaseSchema.parse(JSON.parse(await readFile(path.join(dir, file), "utf8"))));
  }
  return cases;
}

function evaluatePlan(testCase: PlannerEvalCase, plan: JsonValue | undefined, usage?: ModelUsage): PlannerEvalResult {
  const shape = plan && typeof plan === "object" && !Array.isArray(plan) ? plan as Record<string, JsonValue> : undefined;
  const kind = typeof shape?.kind === "string" ? shape.kind : undefined;
  const tool = typeof shape?.tool === "string" ? shape.tool : undefined;
  const task = typeof shape?.task === "string" ? shape.task : undefined;
  const action = extractAction(shape);
  const availableTools = collectNames(testCase.context.tools);
  const availableTasks = collectNames(testCase.context.tasks);
  const checks = {
    json_valid: Boolean(shape),
    expected_kind: kind === testCase.expect.kind,
    target_match: targetMatches(testCase.expect, { tool, task, action }),
    no_premature_final: !(testCase.expect.forbid_premature_final && (kind === "final" || kind === "answer") && testCase.expect.kind !== kind),
    no_hallucinated_reference: !((tool && !availableTools.has(tool)) || (task && !availableTasks.has(task)))
  };
  return {
    name: testCase.name,
    ok: Object.values(checks).every(Boolean),
    checks,
    goal: testCase.goal,
    expected: testCase.expect,
    plan,
    usage
  };
}

function summarizePlannerEval(cases: PlannerEvalCase[], results: PlannerEvalResult[]): PlannerEvalReport {
  const passed = results.filter((result) => result.ok).length;
  const usage = {
    calls: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    baseline_prompt_tokens_estimate: 0,
    estimated_prompt_tokens_saved: 0,
    estimated_prompt_saving_rate: null as number | null
  };
  for (const result of results) {
    if (result.usage) {
      usage.calls += 1;
      usage.prompt_tokens += result.usage.prompt_tokens ?? 0;
      usage.completion_tokens += result.usage.completion_tokens ?? 0;
      usage.total_tokens += result.usage.total_tokens ?? 0;
    }
  }
  usage.baseline_prompt_tokens_estimate = cases.reduce((sum, testCase) => sum + (testCase.baseline.prompt_tokens_estimate ?? testCase.baseline.context_tokens_estimate ?? 0), 0);
  usage.estimated_prompt_tokens_saved = Math.max(0, usage.baseline_prompt_tokens_estimate - usage.prompt_tokens);
  usage.estimated_prompt_saving_rate = usage.baseline_prompt_tokens_estimate > 0
    ? usage.estimated_prompt_tokens_saved / usage.baseline_prompt_tokens_estimate
    : null;

  return {
    ok: passed === results.length,
    cases: results.length,
    passed,
    failed: results.length - passed,
    metrics: {
      json_valid_rate: rate(results, "json_valid"),
      expected_kind_rate: rate(results, "expected_kind"),
      target_match_rate: rate(results, "target_match"),
      premature_final_count: results.filter((result) => !result.checks.no_premature_final).length,
      hallucinated_reference_count: results.filter((result) => !result.checks.no_hallucinated_reference).length
    },
    usage,
    results
  };
}

function rate(results: PlannerEvalResult[], check: keyof PlannerEvalResult["checks"]) {
  if (results.length === 0) {
    return 0;
  }
  return results.filter((result) => result.checks[check]).length / results.length;
}

function targetMatches(expect: PlannerEvalCase["expect"], actual: { tool?: string; task?: string; action?: string }) {
  if (expect.tool && expect.tool !== actual.tool) {
    return false;
  }
  if (expect.task && expect.task !== actual.task) {
    return false;
  }
  if (expect.action && expect.action !== actual.action) {
    return false;
  }
  return true;
}

function extractAction(shape: Record<string, JsonValue> | undefined) {
  const request = shape?.request;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return undefined;
  }
  const action = request.action;
  return typeof action === "string" ? action : undefined;
}

function collectNames(value: unknown) {
  const names = new Set<string>();
  if (!Array.isArray(value)) {
    return names;
  }
  for (const item of value) {
    if (item && typeof item === "object" && !Array.isArray(item) && typeof (item as { name?: unknown }).name === "string") {
      names.add((item as { name: string }).name);
    }
  }
  return names;
}

function plannerEvalSystemPrompt() {
  return [
    "You are Cyborg-Agent's small-model planner.",
    "Return exactly one JSON object. No markdown.",
    "Choose one kind: inspect_context, inspect_tool, inspect_run, create_tool, run_task, call_tool, answer, final.",
    "Prefer registered tasks for recurring goals.",
    "Prefer call_tool when a listed tool directly satisfies the goal.",
    "Never invent tool or task names not listed in context."
  ].join("\n");
}
