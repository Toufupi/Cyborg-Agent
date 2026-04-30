import { loadConfig } from "./config.js";
import { listPolicies } from "./policy.js";
import { listTools } from "./registry.js";
import { listTasks } from "./task.js";
import { doctorTool, type ToolDoctorResult } from "./tool-runtime.js";

export interface CyborgDoctorCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface CyborgDoctorResult {
  ok: boolean;
  checks: CyborgDoctorCheck[];
  tools: ToolDoctorResult[];
}

export async function doctorCyborg(root = process.cwd()): Promise<CyborgDoctorResult> {
  const checks: CyborgDoctorCheck[] = [];
  const tools: ToolDoctorResult[] = [];

  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  checks.push({
    name: "node.version",
    ok: nodeMajor >= 20,
    message: `node ${process.versions.node}`
  });

  try {
    const config = await loadConfig(root);
    checks.push({
      name: "config",
      ok: true,
      message: `model routing: ${config.models.routing.mode}`
    });
  } catch (error) {
    checks.push({
      name: "config",
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    });
  }

  const registeredTools = await listTools(root);
  checks.push({
    name: "tools.registry",
    ok: true,
    message: `registered tools: ${registeredTools.length}`
  });

  for (const { registration } of registeredTools) {
    tools.push(await doctorTool(registration, root));
  }

  const toolNames = new Set(registeredTools.map(({ registration }) => registration.name));
  const tasks = await listTasks(root);
  checks.push({
    name: "tasks.registry",
    ok: true,
    message: `registered tasks: ${tasks.length}`
  });

  for (const { task } of tasks) {
    for (const step of task.steps) {
      checks.push({
        name: `task.${task.name}.${step.name}.tool`,
        ok: toolNames.has(step.tool),
        message: toolNames.has(step.tool)
          ? `uses registered tool '${step.tool}'`
          : `missing registered tool '${step.tool}'`
      });
    }
  }

  const policies = await listPolicies(root);
  checks.push({
    name: "policies.registry",
    ok: true,
    message: policies.length === 0
      ? "no policy files; built-in default policy is active"
      : `registered policies: ${policies.length}`
  });

  return {
    ok: checks.every((check) => check.ok) && tools.every((tool) => tool.ok),
    checks,
    tools
  };
}
