import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { JsonValue } from "./types.js";

export const MemoryTypeSchema = z.enum([
  "run_memory",
  "tool_memory",
  "procedure_memory",
  "preference_memory",
  "error_memory"
]);

export const MemoryRecordSchema = z.object({
  schema: z.literal("cyborg.memory.v0.1"),
  id: z.string().min(1),
  type: MemoryTypeSchema,
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(2000),
  tags: z.array(z.string().min(1)).default([]),
  tool: z.string().min(1).optional(),
  task: z.string().min(1).optional(),
  source_run: z.string().min(1).optional(),
  data: z.unknown().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});

export type MemoryRecord = z.output<typeof MemoryRecordSchema>;
export type MemoryType = z.output<typeof MemoryTypeSchema>;

export interface AddMemoryInput {
  type: MemoryType;
  title: string;
  summary: string;
  tags?: string[];
  tool?: string;
  task?: string;
  source_run?: string;
  data?: unknown;
}

export interface ExtractedMemoryResult {
  source_run: string;
  created: Array<{ file: string; memory: MemoryRecord }>;
  skipped: number;
}

export function memoryDir(root = process.cwd()) {
  return path.join(path.resolve(root), ".cyborg", "memory");
}

export function memoryTypeDir(root: string, type: MemoryType) {
  return path.join(memoryDir(root), type);
}

export async function addMemory(root: string, input: AddMemoryInput) {
  const now = new Date().toISOString();
  const memory = MemoryRecordSchema.parse({
    schema: "cyborg.memory.v0.1",
    id: `mem-${nanoid(10)}`,
    tags: [],
    ...input,
    created_at: now,
    updated_at: now
  });
  const dir = memoryTypeDir(root, memory.type);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${memory.id}.json`);
  await writeFile(file, `${JSON.stringify(memory, null, 2)}\n`, "utf8");
  return { file, memory };
}

export async function extractMemoriesFromRun(root: string, runPath: string): Promise<ExtractedMemoryResult> {
  const file = await resolveRunJson(root, runPath);
  const run = JSON.parse(await readFile(file, "utf8")) as { id?: string; events?: unknown[] };
  const sourceRun = run.id ?? file;
  const existing = await listMemories(root);
  const seen = new Set(existing.map(({ memory }) => extractKey(memory)).filter((key): key is string => Boolean(key)));
  const created: Array<{ file: string; memory: MemoryRecord }> = [];
  let skipped = 0;
  let lastPlan: Record<string, unknown> | undefined;

  for (const event of run.events ?? []) {
    if (!isRecord(event)) {
      continue;
    }
    if (event.type === "agent.plan" && isRecord(event.data) && isRecord(event.data.plan)) {
      lastPlan = event.data.plan;
      continue;
    }
    if (event.type !== "agent.observation" || !isRecord(event.data)) {
      continue;
    }
    const extracted = memoriesFromObservation(sourceRun, lastPlan, event.data);
    for (const input of extracted) {
      const key = extractKey({ type: input.type, data: input.data });
      if (key && seen.has(key)) {
        skipped += 1;
        continue;
      }
      const item = await addMemory(root, input);
      created.push(item);
      if (key) {
        seen.add(key);
      }
    }
  }

  return { source_run: sourceRun, created, skipped };
}

export async function listMemories(root = process.cwd()) {
  const results: Array<{ file: string; memory: MemoryRecord }> = [];
  for (const type of MemoryTypeSchema.options) {
    const dir = memoryTypeDir(root, type);
    try {
      const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
      for (const file of files) {
        const fullPath = path.join(dir, file);
        results.push({
          file: fullPath,
          memory: MemoryRecordSchema.parse(JSON.parse(await readFile(fullPath, "utf8")))
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

export async function searchMemories(root: string, query: { goal?: string; tool?: string; task?: string; tags?: string[]; limit?: number }) {
  const terms = tokenize([query.goal, query.tool, query.task, ...(query.tags ?? [])].filter(Boolean).join(" "));
  const memories = await listMemories(root);
  return memories
    .map((item) => ({ ...item, score: scoreMemory(item.memory, query, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.memory.updated_at.localeCompare(a.memory.updated_at))
    .slice(0, query.limit ?? 5);
}

export function memoryContext(items: Array<{ memory: MemoryRecord; score?: number }>): JsonValue {
  return items.map(({ memory, score }) => {
    const record: Record<string, JsonValue> = {
      id: memory.id,
      type: memory.type,
      title: memory.title,
      summary: memory.summary,
      tags: memory.tags,
      score: score ?? 0
    };
    if (memory.tool) {
      record.tool = memory.tool;
    }
    if (memory.task) {
      record.task = memory.task;
    }
    if (isRecord(memory.data) && typeof memory.data.error_type === "string") {
      record.error_type = memory.data.error_type;
    }
    return record;
  });
}

async function resolveRunJson(root: string, runPath: string) {
  const resolved = path.resolve(root, runPath);
  const stats = await stat(resolved);
  if (stats.isDirectory()) {
    return path.join(resolved, "run.json");
  }
  return resolved;
}

function memoriesFromObservation(sourceRun: string, plan: Record<string, unknown> | undefined, observationEventData: Record<string, unknown>): AddMemoryInput[] {
  const observation = observationEventData.observation;
  const error = findError(observation);
  if (!error) {
    return [];
  }
  const tool = typeof plan?.tool === "string" ? plan.tool : undefined;
  const task = typeof plan?.task === "string" ? plan.task : undefined;
  const action = isRecord(plan?.request) && typeof plan.request.action === "string" ? plan.request.action : undefined;
  const issueSummary = summarizeIssues(error.details);
  const titleTarget = [tool, action].filter(Boolean).join(" ") || task || "Agent step";
  const key = [sourceRun, tool ?? "", task ?? "", action ?? "", error.type, issueSummary].join("|");
  const common = {
    tags: ["agent-run", "error", error.type, ...(action ? [action] : [])],
    tool,
    task,
    source_run: sourceRun,
    data: {
      extract_key: key,
      error_type: error.type,
      action,
      message: error.message,
      details: error.details
    }
  };
  const memories: AddMemoryInput[] = [{
    ...common,
    type: "error_memory",
    title: `${titleTarget} returned ${error.type}`,
    summary: compact([error.message, issueSummary].filter(Boolean).join(" "))
  }];
  if (tool && error.type === "input_validation_error") {
    memories.push({
      ...common,
      type: "tool_memory",
      title: `${tool} validation hint for ${action ?? "request input"}`,
      summary: compact(`When calling ${tool}${action ? ` action ${action}` : ""}, avoid ${error.type}: ${issueSummary || error.message || "check the manifest input contract."}`)
    });
  }
  return memories;
}

function findError(value: unknown): { type: string; message?: string; details?: unknown } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (isRecord(value.error) && typeof value.error.type === "string") {
    return {
      type: value.error.type,
      message: typeof value.error.message === "string" ? value.error.message : undefined,
      details: value.error.details
    };
  }
  if (typeof value.error_type === "string") {
    return {
      type: value.error_type,
      message: typeof value.output === "string" ? value.output : undefined
    };
  }
  for (const item of Object.values(value)) {
    const found = findError(item);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function summarizeIssues(details: unknown) {
  if (!isRecord(details) || !Array.isArray(details.issues)) {
    return "";
  }
  return details.issues
    .slice(0, 5)
    .map((issue) => {
      if (!isRecord(issue)) {
        return "";
      }
      const pathValue = typeof issue.path === "string" ? issue.path : "$";
      const code = typeof issue.code === "string" ? issue.code : "invalid";
      return `${pathValue} ${code}`;
    })
    .filter(Boolean)
    .join("; ");
}

function extractKey(memory: Pick<MemoryRecord, "data"> & { type?: MemoryType }) {
  if (!isRecord(memory.data) || typeof memory.data.extract_key !== "string") {
    return undefined;
  }
  return `${memory.type ?? ""}|${memory.data.extract_key}`;
}

function compact(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 2000 ? `${normalized.slice(0, 1997)}...` : normalized || "Structured agent error extracted from run history.";
}

function scoreMemory(memory: MemoryRecord, query: { tool?: string; task?: string; tags?: string[] }, terms: string[]) {
  let score = 0;
  if (query.tool && memory.tool === query.tool) {
    score += 8;
  }
  if (query.task && memory.task === query.task) {
    score += 8;
  }
  const memoryTags = new Set(memory.tags.map(normalize));
  for (const tag of query.tags ?? []) {
    if (memoryTags.has(normalize(tag))) {
      score += 4;
    }
  }
  const haystack = tokenize(`${memory.title} ${memory.summary} ${memory.tags.join(" ")} ${memory.tool ?? ""} ${memory.task ?? ""}`);
  const haystackSet = new Set(haystack);
  for (const term of terms) {
    if (haystackSet.has(term)) {
      score += 1;
    }
  }
  return score;
}

function tokenize(value: string) {
  return value.toLowerCase().split(/[^a-z0-9_-]+/).filter((item) => item.length >= 2);
}

function normalize(value: string) {
  return value.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
