import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runInvocation } from "./runner.js";
import { addEvent, type CyborgSession } from "./session.js";

export const HookSchema = z.object({
  schema: z.literal("cyborg.hook.v0.1").default("cyborg.hook.v0.1"),
  name: z.string().min(1).regex(/^[a-z][a-z0-9-]*$/),
  description: z.string().max(240).optional(),
  enabled: z.boolean().default(true),
  events: z.array(z.string().min(1)).default(["*"]),
  blocking: z.boolean().default(false),
  invocation: z.object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional()
  })
});

export type CyborgHook = z.output<typeof HookSchema>;

export interface HookEvent {
  schema: "cyborg.hook-event.v0.1";
  time: string;
  event: string;
  message: string;
  data?: unknown;
  session: {
    id: string;
    root: string;
    runDir: string;
  };
}

export function hooksDir(root = process.cwd()) {
  return path.join(path.resolve(root), ".cyborg", "hooks");
}

export function hookPath(name: string, root = process.cwd()) {
  return path.join(hooksDir(root), `${name}.json`);
}

export async function addHook(file: string, root = process.cwd()) {
  const raw = await readFile(path.resolve(file), "utf8");
  const hook = HookSchema.parse(JSON.parse(raw));
  const dir = hooksDir(root);
  const output = hookPath(hook.name, root);
  await mkdir(dir, { recursive: true });
  await writeFile(output, `${JSON.stringify(hook, null, 2)}\n`, "utf8");
  return { output, hook };
}

export async function loadHook(name: string, root = process.cwd()) {
  return HookSchema.parse(JSON.parse(await readFile(hookPath(name, root), "utf8")));
}

export async function listHooks(root = process.cwd()) {
  const dir = hooksDir(root);
  try {
    const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
    return Promise.all(files.map(async (file) => {
      const hook = HookSchema.parse(JSON.parse(await readFile(path.join(dir, file), "utf8")));
      return { file: path.join(dir, file), hook };
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function runHooks(root: string, session: CyborgSession, event: string, message: string, data?: unknown) {
  const hooks = (await listHooks(root))
    .map((item) => item.hook)
    .filter((hook) => hook.enabled && (hook.events.includes("*") || hook.events.includes(event)));

  const payload: HookEvent = {
    schema: "cyborg.hook-event.v0.1",
    time: new Date().toISOString(),
    event,
    message,
    data,
    session: {
      id: session.id,
      root: session.root,
      runDir: session.runDir
    }
  };

  const results = [];
  for (const hook of hooks) {
    const result = await runInvocation(hook.invocation, {
      input: `${JSON.stringify(payload)}\n`,
      cwd: root
    });
    results.push({ hook: hook.name, blocking: hook.blocking, result });
    if (hook.blocking && result.code !== 0) {
      throw new Error(`Blocking hook '${hook.name}' failed with exit code ${result.code ?? "unknown"}: ${result.stderr.trim()}`);
    }
  }
  return results;
}

export async function emitSessionEvent(root: string, session: CyborgSession, type: string, message: string, data?: unknown) {
  addEvent(session, type, message, data);
  const results = await runHooks(root, session, type, message, data);
  for (const item of results) {
    addEvent(session, item.result.code === 0 ? "hook.ok" : "hook.failed", `Hook ${item.hook} handled ${type}`, {
      hook: item.hook,
      event: type,
      code: item.result.code,
      stdout: item.result.stdout,
      stderr: item.result.stderr
    });
  }
}
