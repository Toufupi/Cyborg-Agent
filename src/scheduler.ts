import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { listTasks } from "./task.js";
import { runTask } from "./agent/task-runner.js";

export interface SchedulerState {
  schema: "cyborg.scheduler-state.v0.1";
  tasks: Record<string, {
    last_run_at?: string;
    last_run?: string;
  }>;
}

export function schedulerStatePath(root = process.cwd()) {
  return path.join(path.resolve(root), ".cyborg", "scheduler", "state.json");
}

export async function loadSchedulerState(root = process.cwd()): Promise<SchedulerState> {
  try {
    return JSON.parse(await readFile(schedulerStatePath(root), "utf8")) as SchedulerState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schema: "cyborg.scheduler-state.v0.1", tasks: {} };
    }
    throw error;
  }
}

export async function saveSchedulerState(root: string, state: SchedulerState) {
  const file = schedulerStatePath(root);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return { file, state };
}

export async function runDueTasks(root = process.cwd(), now = new Date()) {
  const state = await loadSchedulerState(root);
  const tasks = await listTasks(root);
  const runs: Array<{ task: string; run: string }> = [];
  for (const { task } of tasks) {
    if (!task.schedule || !isDue(task.schedule, state.tasks[task.name]?.last_run_at, now)) {
      continue;
    }
    const result = await runTask(task.name, root);
    state.tasks[task.name] = {
      last_run_at: now.toISOString(),
      last_run: result.file
    };
    runs.push({ task: task.name, run: result.file });
  }
  await saveSchedulerState(root, state);
  return { runs, state };
}

export async function watchDueTasks(root = process.cwd(), intervalMs = 60_000, signal?: AbortSignal, onRun?: (result: Awaited<ReturnType<typeof runDueTasks>>) => void) {
  while (!signal?.aborted) {
    const result = await runDueTasks(root);
    onRun?.(result);
    await sleep(intervalMs, signal);
  }
}

export function isDue(schedule: string, lastRunAt: string | undefined, now = new Date()) {
  if (schedule === "@once") {
    return !lastRunAt;
  }
  if (schedule === "@hourly") {
    return elapsed(lastRunAt, now) >= 60 * 60 * 1000;
  }
  if (schedule === "@daily") {
    return elapsed(lastRunAt, now) >= 24 * 60 * 60 * 1000;
  }
  const every = /^every\s+(\d+)\s*(second|seconds|minute|minutes|hour|hours)$/i.exec(schedule);
  if (every) {
    const count = Number(every[1]);
    const unit = every[2].toLowerCase();
    const ms = unit.startsWith("second") ? count * 1000 : unit.startsWith("minute") ? count * 60_000 : count * 3_600_000;
    return elapsed(lastRunAt, now) >= ms;
  }
  return false;
}

function elapsed(lastRunAt: string | undefined, now: Date) {
  if (!lastRunAt) {
    return Number.POSITIVE_INFINITY;
  }
  return now.getTime() - new Date(lastRunAt).getTime();
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}
