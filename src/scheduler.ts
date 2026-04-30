import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { listTasks } from "./task.js";
import { runTask } from "./agent/task-runner.js";
import { appendAuditEvent } from "./audit.js";

export interface SchedulerState {
  schema: "cyborg.scheduler-state.v0.1";
  tasks: Record<string, {
    last_run_at?: string;
    last_run?: string;
    last_error?: string;
  }>;
  daemon?: SchedulerDaemonState;
}

export interface SchedulerDaemonState {
  status: "idle" | "watching" | "stopped" | "failed";
  pid: number;
  interval_ms: number;
  started_at: string;
  updated_at: string;
  last_tick_at?: string;
  last_error?: string;
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
  const errors: Array<{ task: string; error: string }> = [];
  for (const { task } of tasks) {
    if (!task.schedule || !isDue(task.schedule, state.tasks[task.name]?.last_run_at, now)) {
      continue;
    }
    await appendAuditEvent(root, {
      type: "scheduler.task.start",
      actor: "scheduler",
      subject: task.name,
      decision: "start",
      details: {
        schedule: task.schedule
      }
    });
    try {
      const result = await runTask(task.name, root);
      const runFailure = await readTaskRunFailure(result.file);
      state.tasks[task.name] = {
        last_run_at: now.toISOString(),
        last_run: result.file,
        last_error: runFailure
      };
      runs.push({ task: task.name, run: result.file });
      if (runFailure) {
        errors.push({ task: task.name, error: runFailure });
      }
      await appendAuditEvent(root, {
        type: runFailure ? "scheduler.task.error" : "scheduler.task.end",
        actor: "scheduler",
        subject: task.name,
        decision: runFailure ? "failed" : "completed",
        details: {
          run: result.file,
          error: runFailure
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.tasks[task.name] = {
        ...state.tasks[task.name],
        last_run_at: now.toISOString(),
        last_error: message
      };
      errors.push({ task: task.name, error: message });
      await appendAuditEvent(root, {
        type: "scheduler.task.error",
        actor: "scheduler",
        subject: task.name,
        decision: "failed",
        details: {
          error: message
        }
      });
    }
  }
  await saveSchedulerState(root, state);
  return { runs, errors, state };
}

export async function watchDueTasks(root = process.cwd(), intervalMs = 60_000, signal?: AbortSignal, onRun?: (result: Awaited<ReturnType<typeof runDueTasks>>) => void) {
  await updateSchedulerDaemon(root, {
    status: "watching",
    pid: process.pid,
    interval_ms: intervalMs,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
  await appendAuditEvent(root, {
    type: "scheduler.daemon.start",
    actor: "scheduler",
    decision: "start",
    details: {
      pid: process.pid,
      interval_ms: intervalMs
    }
  });
  try {
    while (!signal?.aborted) {
      const tickAt = new Date().toISOString();
      await updateSchedulerDaemon(root, {
        status: "watching",
        pid: process.pid,
        interval_ms: intervalMs,
        started_at: (await loadSchedulerState(root)).daemon?.started_at ?? tickAt,
        updated_at: tickAt,
        last_tick_at: tickAt
      });
      const result = await runDueTasks(root);
      onRun?.(result);
      await sleep(intervalMs, signal);
    }
    await updateSchedulerDaemon(root, {
      status: "stopped",
      pid: process.pid,
      interval_ms: intervalMs,
      started_at: (await loadSchedulerState(root)).daemon?.started_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_tick_at: (await loadSchedulerState(root)).daemon?.last_tick_at
    });
    await appendAuditEvent(root, {
      type: "scheduler.daemon.stop",
      actor: "scheduler",
      decision: "stopped",
      details: {
        pid: process.pid
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateSchedulerDaemon(root, {
      status: "failed",
      pid: process.pid,
      interval_ms: intervalMs,
      started_at: (await loadSchedulerState(root)).daemon?.started_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_error: message
    });
    await appendAuditEvent(root, {
      type: "scheduler.daemon.error",
      actor: "scheduler",
      decision: "failed",
      details: {
        pid: process.pid,
        error: message
      }
    });
    throw error;
  }
}

export async function updateSchedulerDaemon(root: string, daemon: SchedulerDaemonState) {
  const state = await loadSchedulerState(root);
  state.daemon = daemon;
  return saveSchedulerState(root, state);
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

async function readTaskRunFailure(file: string) {
  const run = JSON.parse(await readFile(file, "utf8")) as {
    events?: Array<{ type?: string; message?: string; data?: { stderr?: string; code?: number | null } }>;
  };
  const failed = run.events?.find((event) => event.type === "step.failed");
  if (!failed) {
    return undefined;
  }
  const stderr = failed.data?.stderr?.trim();
  return stderr || failed.message || `Task step failed with code ${failed.data?.code ?? "unknown"}.`;
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
