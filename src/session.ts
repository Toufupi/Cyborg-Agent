import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";

export interface SessionEvent {
  time: string;
  type: string;
  message: string;
  data?: unknown;
}

export interface CyborgSession {
  id: string;
  root: string;
  runDir: string;
  events: SessionEvent[];
}

export async function createSession(root = process.cwd(), prefix = "run") {
  const id = `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${nanoid(8)}`;
  const runDir = path.join(path.resolve(root), ".cyborg", "runs", id);
  await mkdir(runDir, { recursive: true });
  return { id, root: path.resolve(root), runDir, events: [] } satisfies CyborgSession;
}

export function addEvent(session: CyborgSession, type: string, message: string, data?: unknown) {
  session.events.push({
    time: new Date().toISOString(),
    type,
    message,
    data
  });
}

export async function saveSession(session: CyborgSession) {
  const file = path.join(session.runDir, "run.json");
  await writeFile(file, `${JSON.stringify({
    id: session.id,
    root: session.root,
    events: session.events
  }, null, 2)}\n`, "utf8");
  return { file };
}

export async function listRuns(root = process.cwd(), prefix?: string) {
  const runsDir = path.join(path.resolve(root), ".cyborg", "runs");
  try {
    const dirs = (await readdir(runsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => prefix ? name.startsWith(prefix) : true)
      .sort()
      .reverse();
    return Promise.all(dirs.map(async (dir) => {
      const file = path.join(runsDir, dir, "run.json");
      const run = JSON.parse(await readFile(file, "utf8")) as unknown;
      return { id: dir, file, run };
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
