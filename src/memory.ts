import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
    return record;
  });
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
