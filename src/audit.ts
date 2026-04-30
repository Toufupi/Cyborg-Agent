import { mkdir, appendFile, readFile } from "node:fs/promises";
import path from "node:path";

export interface AuditEvent {
  time: string;
  type: string;
  actor?: string;
  subject?: string;
  decision?: string;
  details?: unknown;
}

export function auditDir(root = process.cwd()) {
  return path.join(path.resolve(root), ".cyborg", "audit");
}

export function auditLogPath(root = process.cwd()) {
  return path.join(auditDir(root), "events.jsonl");
}

export async function appendAuditEvent(root: string, event: Omit<AuditEvent, "time">) {
  await mkdir(auditDir(root), { recursive: true });
  const record: AuditEvent = {
    time: new Date().toISOString(),
    ...event
  };
  await appendFile(auditLogPath(root), `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export async function readAuditEvents(root = process.cwd()) {
  try {
    const raw = await readFile(auditLogPath(root), "utf8");
    return raw.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as AuditEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function summarizeAudit(root = process.cwd()) {
  const events = await readAuditEvents(root);
  const summary = {
    events: events.length,
    by_type: {} as Record<string, number>,
    by_decision: {} as Record<string, number>,
    denied: 0,
    approvals: 0,
    recent: events.slice(-10)
  };
  for (const event of events) {
    summary.by_type[event.type] = (summary.by_type[event.type] ?? 0) + 1;
    if (event.decision) {
      summary.by_decision[event.decision] = (summary.by_decision[event.decision] ?? 0) + 1;
    }
    if (event.decision === "deny" || event.decision === "failed") {
      summary.denied += 1;
    }
    if (event.type.includes("approval") || event.decision === "stop-requested") {
      summary.approvals += 1;
    }
  }
  return summary;
}
