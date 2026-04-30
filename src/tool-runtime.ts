import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { runInvocation } from "./runner.js";
import type { Invocation, ToolRegistration } from "./types.js";

export interface ToolDoctorResult {
  ok: boolean;
  tool: string;
  runtime: string;
  cwd?: string;
  package_manager?: string;
  checks: Array<{
    name: string;
    ok: boolean;
    message: string;
  }>;
}

export interface ToolEnvSummary {
  tool: string;
  runtime: string;
  isolated: boolean;
  install_strategy: string;
  cwd?: string;
  package_manager?: string;
  required_env: string[];
  exported_env: Record<string, string>;
  path_prepend: string[];
  invocation_cwd: string;
}

export function resolveToolRuntimeCwd(registration: ToolRegistration, root = process.cwd()) {
  const runtimeCwd = registration.runtime?.cwd;
  if (!runtimeCwd) {
    return undefined;
  }
  return path.isAbsolute(runtimeCwd) ? path.resolve(runtimeCwd) : path.resolve(root, runtimeCwd);
}

export function assertToolRuntimeReady(registration: ToolRegistration, root = process.cwd()) {
  if (registration.runtime?.isolated && !resolveToolRuntimeCwd(registration, root)) {
    throw new Error(`Tool '${registration.name}' declares runtime.isolated but does not declare runtime.cwd.`);
  }
  if (registration.runtime?.type && registration.runtime.type !== "node") {
    throw new Error(`Tool '${registration.name}' declares unsupported runtime '${registration.runtime.type}'. Supported runtime: node.`);
  }
}

export function prepareToolInvocation(registration: ToolRegistration, invocation: Invocation, root = process.cwd()): Invocation {
  assertToolRuntimeReady(registration, root);
  const runtimeCwd = resolveToolRuntimeCwd(registration, root);
  return {
    ...invocation,
    cwd: invocation.cwd ? resolveInvocationCwd(invocation.cwd, runtimeCwd ?? root) : runtimeCwd ?? invocation.cwd
  };
}

export function prepareToolEnv(registration: ToolRegistration, baseEnv: Record<string, string> = {}, root = process.cwd()) {
  assertToolRuntimeReady(registration, root);
  const runtimeCwd = resolveToolRuntimeCwd(registration, root);
  const env = { ...baseEnv };
  if (runtimeCwd) {
    env.CYBORG_TOOL_RUNTIME_CWD = runtimeCwd;
  }
  if (registration.runtime?.isolated) {
    env.CYBORG_TOOL_ISOLATED = "1";
  }
  if (registration.runtime?.type === "node" && runtimeCwd) {
    const binPath = path.join(runtimeCwd, "node_modules", ".bin");
    env.PATH = [binPath, baseEnv.PATH ?? process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);
  }
  return env;
}

export function describeToolEnv(registration: ToolRegistration, invocation?: Invocation, root = process.cwd()): ToolEnvSummary {
  const runtimeCwd = resolveToolRuntimeCwd(registration, root);
  const preparedInvocation = invocation ? prepareToolInvocation(registration, invocation, root) : undefined;
  const exportedEnv = prepareToolEnv(registration, {}, root);
  const pathPrepend = registration.runtime?.type === "node" && runtimeCwd
    ? [path.join(runtimeCwd, "node_modules", ".bin")]
    : [];

  return {
    tool: registration.name,
    runtime: registration.runtime?.type ?? "unknown",
    isolated: registration.runtime?.isolated ?? false,
    install_strategy: registration.runtime?.install_strategy ?? "none",
    cwd: runtimeCwd,
    package_manager: registration.runtime?.package_manager,
    required_env: registration.runtime?.required_env ?? [],
    exported_env: Object.fromEntries(Object.entries(exportedEnv).filter(([key]) => key !== "PATH")),
    path_prepend: pathPrepend,
    invocation_cwd: preparedInvocation?.cwd ?? runtimeCwd ?? root
  };
}

export async function doctorTool(registration: ToolRegistration, root = process.cwd()): Promise<ToolDoctorResult> {
  const runtime = registration.runtime?.type ?? "unknown";
  const cwd = resolveToolRuntimeCwd(registration, root);
  const packageManager = registration.runtime?.package_manager;
  const checks: ToolDoctorResult["checks"] = [];

  if (registration.runtime?.isolated && !cwd) {
    checks.push({
      name: "runtime.cwd",
      ok: false,
      message: "isolated tools must declare runtime.cwd"
    });
  } else if (cwd) {
    checks.push(await pathCheck("runtime.cwd", cwd, "runtime cwd exists"));
  }

  if (runtime === "node") {
    if (cwd) {
      const packageJson = path.join(cwd, "package.json");
      checks.push(await pathCheck("package.json", packageJson, "package.json exists"));
      checks.push(await pathCheck("node_modules", path.join(cwd, "node_modules"), "node_modules exists"));
      try {
        const parsed = JSON.parse(await readFile(packageJson, "utf8")) as { name?: string };
        checks.push({
          name: "package.name",
          ok: Boolean(parsed.name),
          message: parsed.name ? `package name: ${parsed.name}` : "package.json has no name"
        });
      } catch {
        checks.push({
          name: "package.name",
          ok: false,
          message: "package.json is missing or invalid"
        });
      }
    }
    checks.push({
      name: "package_manager",
      ok: packageManager === "npm" || packageManager === "pnpm" || packageManager === "yarn",
      message: packageManager ? `package manager: ${packageManager}` : "node tools should declare runtime.package_manager"
    });
  }

  return {
    ok: checks.every((check) => check.ok),
    tool: registration.name,
    runtime,
    cwd,
    package_manager: packageManager,
    checks
  };
}

export async function installTool(registration: ToolRegistration, root = process.cwd()) {
  if (registration.runtime?.type !== "node") {
    throw new Error(`Tool '${registration.name}' is not a node runtime tool.`);
  }
  const cwd = resolveToolRuntimeCwd(registration, root);
  if (!cwd) {
    throw new Error(`Tool '${registration.name}' does not declare runtime.cwd.`);
  }
  const packageManager = registration.runtime.package_manager ?? "npm";
  const command = packageManager;
  const args = packageManager === "npm" ? ["install"] : ["install"];
  return runInvocation({ command, args, cwd }, {
    cwd,
    env: prepareToolEnv(registration, {}, root)
  });
}

async function pathCheck(name: string, target: string, okMessage: string) {
  try {
    await access(target);
    return { name, ok: true, message: okMessage };
  } catch {
    return { name, ok: false, message: `${target} does not exist` };
  }
}

function resolveInvocationCwd(invocationCwd: string, base: string) {
  return path.isAbsolute(invocationCwd) ? path.resolve(invocationCwd) : path.resolve(base, invocationCwd);
}
