import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const TaskSchema = z.object({
  name: z.string().min(1).regex(/^[a-z][a-z0-9-]*$/),
  description: z.string().max(240).optional(),
  schedule: z.string().min(1).optional(),
  model_profile: z.enum(["small", "large", "auto", "manual"]).default("auto"),
  tools: z.array(z.string().min(1)).default([]),
  goal: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()).default({}),
  outputs: z.record(z.string(), z.string()).default({}),
  steps: z.array(z.object({
    name: z.string().min(1),
    tool: z.string().min(1),
    action: z.string().min(1),
    input: z.record(z.string(), z.unknown()).default({}),
    inputFromPrevious: z.boolean().default(false)
  })).default([])
});

export type CyborgTask = z.output<typeof TaskSchema>;

export function tasksDir(root = process.cwd()) {
  return path.join(path.resolve(root), ".cyborg", "tasks");
}

export function taskPath(name: string, root = process.cwd()) {
  return path.join(tasksDir(root), `${name}.json`);
}

export async function addTask(file: string, root = process.cwd()) {
  const raw = await readFile(path.resolve(file), "utf8");
  const task = TaskSchema.parse(JSON.parse(raw));
  const dir = tasksDir(root);
  const output = taskPath(task.name, root);
  await mkdir(dir, { recursive: true });
  await writeFile(output, `${JSON.stringify(task, null, 2)}\n`, "utf8");
  return { output, task };
}

export async function loadTask(name: string, root = process.cwd()) {
  return TaskSchema.parse(JSON.parse(await readFile(taskPath(name, root), "utf8")));
}

export async function listTasks(root = process.cwd()) {
  const dir = tasksDir(root);
  try {
    const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
    return Promise.all(files.map(async (file) => {
      const task = TaskSchema.parse(JSON.parse(await readFile(path.join(dir, file), "utf8")));
      return { file: path.join(dir, file), task };
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
