import { spawn } from "node:child_process";
import type { Invocation } from "./types.js";
import { createApproval, consumeAllowedApproval } from "./approvals.js";
import { assertPolicyDecision, checkInvocation, sanitizeEnv, type CyborgPolicy } from "./policy.js";

export interface RunOptions {
  input?: string;
  cwd?: string;
  env?: Record<string, string>;
  policy?: CyborgPolicy;
  workspaceRoot?: string;
  requester?: {
    agent?: string;
    session_id?: string;
  };
}

function resolveCommand(command: string) {
  return command;
}

function resolveSpawn(command: string, args: string[]) {
  if (process.platform === "win32" && ["npm", "npx", "pnpm", "yarn"].includes(command)) {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", command, ...args]
    };
  }
  return { command: resolveCommand(command), args };
}

export async function runInvocation(invocation: Invocation, options: RunOptions = {}) {
  if (options.policy) {
    const workspaceRoot = options.workspaceRoot ?? options.cwd ?? process.cwd();
    const decision = checkInvocation(options.policy, invocation, workspaceRoot);
    if (!decision.allowed && options.policy.approvals.mode === "ask") {
      const consumed = await consumeAllowedApproval(workspaceRoot, invocation);
      if (!consumed) {
        const approval = await createApproval(workspaceRoot, {
          policy: options.policy.name,
          scope: decision.scope,
          subject: decision.subject,
          reason: decision.reason,
          invocation,
          requester: options.requester,
          ttlMs: 30 * 60 * 1000
        });
        throw new Error(`Approval required for ${decision.scope} '${decision.subject}'. Pending approval: ${approval.approval.id}`);
      }
    } else {
      assertPolicyDecision(decision);
    }
  }
  const spawnTarget = resolveSpawn(invocation.command, invocation.args ?? []);
  const cwd = invocation.cwd ?? options.cwd ?? process.cwd();
  const env = options.policy
    ? sanitizeEnv(options.policy, { ...process.env, ...options.env }).allowed
    : { ...process.env, ...options.env };
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(spawnTarget.command, spawnTarget.args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
    if (options.input !== undefined) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}
