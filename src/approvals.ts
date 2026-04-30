import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { Invocation } from "./types.js";

export const ApprovalRequestSchema = z.object({
  schema: z.literal("cyborg.approval.v0.1"),
  id: z.string().min(1),
  status: z.enum(["pending", "allowed", "denied", "expired"]),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  expires_at: z.string().datetime().optional(),
  policy: z.string().min(1),
  scope: z.string().min(1),
  subject: z.string().min(1),
  reason: z.string().min(1),
  decision: z.enum(["allow-once", "deny"]).optional(),
  invocation: z.object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    cwd: z.string().optional()
  }).optional(),
  fingerprint: z.string().min(1).optional(),
  requester: z.object({
    agent: z.string().optional(),
    session_id: z.string().optional()
  }).default({})
});

export type ApprovalRequest = z.output<typeof ApprovalRequestSchema>;

export interface CreateApprovalInput {
  policy: string;
  scope: string;
  subject: string;
  reason: string;
  invocation?: Invocation;
  requester?: ApprovalRequest["requester"];
  ttlMs?: number;
}

export function approvalsDir(root = process.cwd()) {
  return path.join(path.resolve(root), ".cyborg", "approvals");
}

export function pendingApprovalsDir(root = process.cwd()) {
  return path.join(approvalsDir(root), "pending");
}

export function resolvedApprovalsDir(root = process.cwd()) {
  return path.join(approvalsDir(root), "resolved");
}

export function approvalFingerprint(invocation: Invocation) {
  const stable = JSON.stringify({
    command: invocation.command,
    args: invocation.args ?? [],
    cwd: invocation.cwd
  });
  return crypto.createHash("sha256").update(stable).digest("hex");
}

export async function createApproval(root: string, input: CreateApprovalInput) {
  const now = new Date();
  const approval = ApprovalRequestSchema.parse({
    schema: "cyborg.approval.v0.1",
    id: `apr-${nanoid(10)}`,
    status: "pending",
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    expires_at: input.ttlMs ? new Date(now.getTime() + input.ttlMs).toISOString() : undefined,
    policy: input.policy,
    scope: input.scope,
    subject: input.subject,
    reason: input.reason,
    invocation: input.invocation ? {
      command: input.invocation.command,
      args: input.invocation.args ?? [],
      cwd: input.invocation.cwd
    } : undefined,
    fingerprint: input.invocation ? approvalFingerprint(input.invocation) : undefined,
    requester: input.requester ?? {}
  });
  await mkdir(pendingApprovalsDir(root), { recursive: true });
  const file = path.join(pendingApprovalsDir(root), `${approval.id}.json`);
  await writeFile(file, `${JSON.stringify(approval, null, 2)}\n`, "utf8");
  return { file, approval };
}

export async function listApprovals(root = process.cwd(), status: "pending" | "resolved" | "all" = "pending") {
  const dirs = status === "all"
    ? [pendingApprovalsDir(root), resolvedApprovalsDir(root)]
    : [status === "pending" ? pendingApprovalsDir(root) : resolvedApprovalsDir(root)];
  const results: Array<{ file: string; approval: ApprovalRequest }> = [];
  for (const dir of dirs) {
    try {
      const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
      for (const file of files) {
        const fullPath = path.join(dir, file);
        results.push({
          file: fullPath,
          approval: ApprovalRequestSchema.parse(JSON.parse(await readFile(fullPath, "utf8")))
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return results;
}

export async function resolveApproval(root: string, id: string, decision: "allow-once" | "deny") {
  const pendingFile = path.join(pendingApprovalsDir(root), `${id}.json`);
  const approval = ApprovalRequestSchema.parse(JSON.parse(await readFile(pendingFile, "utf8")));
  const updated = ApprovalRequestSchema.parse({
    ...approval,
    status: decision === "allow-once" ? "allowed" : "denied",
    decision,
    updated_at: new Date().toISOString()
  });
  await mkdir(resolvedApprovalsDir(root), { recursive: true });
  const resolvedFile = path.join(resolvedApprovalsDir(root), `${id}.json`);
  await writeFile(pendingFile, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  await rename(pendingFile, resolvedFile);
  return { file: resolvedFile, approval: updated };
}

export async function consumeAllowedApproval(root: string, invocation: Invocation) {
  const fingerprint = approvalFingerprint(invocation);
  const approvals = await listApprovals(root, "resolved");
  const match = approvals.find(({ approval }) => approval.status === "allowed" && approval.decision === "allow-once" && approval.fingerprint === fingerprint);
  if (!match) {
    return undefined;
  }
  const consumed = ApprovalRequestSchema.parse({
    ...match.approval,
    status: "expired",
    updated_at: new Date().toISOString()
  });
  await writeFile(match.file, `${JSON.stringify(consumed, null, 2)}\n`, "utf8");
  return { file: match.file, approval: consumed };
}
