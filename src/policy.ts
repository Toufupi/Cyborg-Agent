import path from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { Invocation } from "./types.js";

export const CyborgPolicySchema = z.object({
  schema: z.literal("cyborg.policy.v0.1").default("cyborg.policy.v0.1"),
  name: z.string().min(1).regex(/^[a-z][a-z0-9-]*$/),
  description: z.string().max(240).optional(),
  security: z.object({
    mode: z.enum(["restricted", "workspace", "bypass-all"]).default("workspace")
  }).default({ mode: "workspace" }),
  tools: z.object({
    allow: z.array(z.string().min(1)).default([]),
    deny: z.array(z.string().min(1)).default([])
  }).default({ allow: [], deny: [] }),
  tasks: z.object({
    allow: z.array(z.string().min(1)).default([]),
    deny: z.array(z.string().min(1)).default([])
  }).default({ allow: [], deny: [] }),
  commands: z.object({
    allow: z.array(z.string().min(1)).default(["node", "npm", "npx"]),
    deny: z.array(z.string().min(1)).default(["powershell", "pwsh", "cmd", "bash", "sh"])
  }).default({ allow: ["node", "npm", "npx"], deny: ["powershell", "pwsh", "cmd", "bash", "sh"] }),
  env: z.object({
    allow: z.array(z.string().min(1)).default([
      "CYBORG_SHELL",
      "CYBORG_WORKSPACE_ROOT",
      "CYBORG_TOOL_REGISTRY",
      "CYBORG_SESSION_ID",
      "CYBORG_TOOL_RUNTIME_CWD",
      "CYBORG_TOOL_ISOLATED",
      "PATH",
      "NODE_ENV"
    ]),
    deny_patterns: z.array(z.string().min(1)).default([
      ".*(API_KEY|TOKEN|PASSWORD|PRIVATE_KEY|SECRET)$"
    ])
  }).default({
    allow: [
      "CYBORG_SHELL",
      "CYBORG_WORKSPACE_ROOT",
      "CYBORG_TOOL_REGISTRY",
      "CYBORG_SESSION_ID",
      "CYBORG_TOOL_RUNTIME_CWD",
      "CYBORG_TOOL_ISOLATED",
      "PATH",
      "NODE_ENV"
    ],
    deny_patterns: [".*(API_KEY|TOKEN|PASSWORD|PRIVATE_KEY|SECRET)$"]
  }),
  workspace: z.object({
    cwd_must_be_inside_root: z.boolean().default(true),
    filesystem_must_stay_inside_root: z.boolean().default(true),
    read: z.array(z.string().min(1)).default(["."]),
    write: z.array(z.string().min(1)).default(["."])
  }).default({
    cwd_must_be_inside_root: true,
    filesystem_must_stay_inside_root: true,
    read: ["."],
    write: ["."]
  }),
  approvals: z.object({
    mode: z.enum(["deny", "allow", "ask"]).default("deny")
  }).default({ mode: "deny" }),
  network: z.object({
    mode: z.enum(["deny", "allow", "ask"]).default("deny"),
    allow_hosts: z.array(z.string().min(1)).default([])
  }).default({ mode: "deny", allow_hosts: [] }),
  audit: z.object({
    enabled: z.boolean().default(true)
  }).default({ enabled: true })
});

export type CyborgPolicy = z.output<typeof CyborgPolicySchema>;

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  scope: string;
  subject: string;
  policy: string;
}

export function policiesDir(root = process.cwd()) {
  return path.join(path.resolve(root), ".cyborg", "policies");
}

export function policyPath(name: string, root = process.cwd()) {
  return path.join(policiesDir(root), `${name}.json`);
}

export function defaultPolicy(name = "default"): CyborgPolicy {
  return CyborgPolicySchema.parse({ name });
}

export async function addPolicy(file: string, root = process.cwd()) {
  const raw = await readFile(path.resolve(file), "utf8");
  const policy = CyborgPolicySchema.parse(JSON.parse(raw));
  const dir = policiesDir(root);
  const output = policyPath(policy.name, root);
  await mkdir(dir, { recursive: true });
  await writeFile(output, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  return { output, policy };
}

export async function loadPolicy(name = "default", root = process.cwd()) {
  try {
    return CyborgPolicySchema.parse(JSON.parse(await readFile(policyPath(name, root), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && name === "default") {
      return defaultPolicy();
    }
    throw error;
  }
}

export async function listPolicies(root = process.cwd()) {
  const dir = policiesDir(root);
  try {
    const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
    return Promise.all(files.map(async (file) => {
      const policy = CyborgPolicySchema.parse(JSON.parse(await readFile(path.join(dir, file), "utf8")));
      return { file: path.join(dir, file), policy };
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function assertPolicyDecision(decision: PolicyDecision) {
  if (!decision.allowed) {
    throw new Error(`Policy '${decision.policy}' denied ${decision.scope} '${decision.subject}': ${decision.reason}`);
  }
}

export function checkTool(policy: CyborgPolicy, tool: string): PolicyDecision {
  if (isBypassAll(policy)) {
    return allow(policy, "tool", tool, "bypass-all mode");
  }
  return checkNamedList(policy, "tool", tool, policy.tools.allow, policy.tools.deny);
}

export function checkTask(policy: CyborgPolicy, task: string): PolicyDecision {
  if (isBypassAll(policy)) {
    return allow(policy, "task", task, "bypass-all mode");
  }
  return checkNamedList(policy, "task", task, policy.tasks.allow, policy.tasks.deny);
}

export function checkInvocation(policy: CyborgPolicy, invocation: Invocation, root = process.cwd()): PolicyDecision {
  if (isBypassAll(policy)) {
    return allow(policy, "invocation", invocation.command, "bypass-all mode");
  }
  const command = normalizeCommand(invocation.command);
  const commandDecision = checkNamedList(policy, "command", command, policy.commands.allow, policy.commands.deny);
  if (!commandDecision.allowed) {
    return commandDecision;
  }
  if (policy.workspace.cwd_must_be_inside_root) {
    const cwd = path.resolve(invocation.cwd ?? root);
    const workspace = path.resolve(root);
    if (!isPathInside(workspace, cwd)) {
      return deny(policy, "workspace.cwd", cwd, "cwd is outside workspace root");
    }
  }
  return allow(policy, "invocation", command, "command and cwd allowed");
}

export function checkWorkspacePath(policy: CyborgPolicy, targetPath: string, root = process.cwd(), access: "read" | "write" = "read"): PolicyDecision {
  if (isBypassAll(policy)) {
    return allow(policy, `filesystem.${access}`, targetPath, "bypass-all mode");
  }
  const workspace = path.resolve(root);
  const resolved = path.resolve(root, targetPath);
  if (policy.workspace.filesystem_must_stay_inside_root && !isPathInside(workspace, resolved)) {
    return deny(policy, `filesystem.${access}`, resolved, "path is outside workspace root");
  }
  const allowedRoots = policy.workspace[access].map((item) => path.resolve(root, item));
  const matched = allowedRoots.some((allowedRoot) => isPathInside(allowedRoot, resolved));
  if (!matched) {
    return deny(policy, `filesystem.${access}`, resolved, `path is not inside allowed ${access} roots`);
  }
  return allow(policy, `filesystem.${access}`, resolved, "path allowed");
}

export function checkNetwork(policy: CyborgPolicy, url: string): PolicyDecision {
  if (isBypassAll(policy)) {
    return allow(policy, "network", url, "bypass-all mode");
  }
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return deny(policy, "network", url, "invalid url");
  }
  if (policy.network.mode === "allow") {
    if (policy.network.allow_hosts.length === 0 || policy.network.allow_hosts.map(normalizeName).includes(host)) {
      return allow(policy, "network", host, "network host allowed");
    }
  }
  if (policy.network.mode === "ask" && policy.network.allow_hosts.map(normalizeName).includes(host)) {
    return allow(policy, "network", host, "network host allowed");
  }
  return deny(policy, "network", host, "network host not allowed");
}

export function sanitizeEnv(policy: CyborgPolicy, env: Record<string, string | undefined>) {
  if (isBypassAll(policy)) {
    const allowed: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) {
        allowed[key] = value;
      }
    }
    return { allowed, blocked: [] };
  }
  const allowed: Record<string, string> = {};
  const blocked: string[] = [];
  const denyPatterns = policy.env.deny_patterns.map((pattern) => new RegExp(pattern, "i"));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }
    if (denyPatterns.some((pattern) => pattern.test(key))) {
      blocked.push(key);
      continue;
    }
    if (!policy.env.allow.includes(key)) {
      blocked.push(key);
      continue;
    }
    allowed[key] = value;
  }
  return { allowed, blocked };
}

export function isBypassAll(policy: CyborgPolicy) {
  return policy.security.mode === "bypass-all";
}

function checkNamedList(policy: CyborgPolicy, scope: string, subject: string, allowList: string[], denyList: string[]) {
  const normalized = normalizeName(subject);
  const denied = denyList.map(normalizeName);
  if (denied.includes(normalized) || denied.includes("*")) {
    return deny(policy, scope, subject, "matched deny list");
  }
  const allowed = allowList.map(normalizeName);
  if (allowed.length === 0 || allowed.includes(normalized) || allowed.includes("*")) {
    return allow(policy, scope, subject, "matched allow list");
  }
  return deny(policy, scope, subject, "not in allow list");
}

function allow(policy: CyborgPolicy, scope: string, subject: string, reason: string): PolicyDecision {
  return { allowed: true, reason, scope, subject, policy: policy.name };
}

function deny(policy: CyborgPolicy, scope: string, subject: string, reason: string): PolicyDecision {
  return { allowed: false, reason, scope, subject, policy: policy.name };
}

function normalizeCommand(command: string) {
  return path.basename(command).replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

function normalizeName(value: string) {
  return value.trim().toLowerCase();
}

function isPathInside(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
