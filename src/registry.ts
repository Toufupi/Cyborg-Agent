import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolRegistration } from "./types.js";

const TOOL_SCHEMA = "a2c2a.tool-registration.v0.1";

export function registryRoot(root = process.cwd()) {
  return path.join(path.resolve(root), ".cyborg", "tools");
}

function toolFile(root: string, name: string) {
  return path.join(registryRoot(root), `${name}.json`);
}

function assertToolRegistration(value: unknown): asserts value is ToolRegistration {
  if (typeof value !== "object" || value === null) {
    throw new Error("Tool registration must be a JSON object.");
  }
  const item = value as Partial<ToolRegistration>;
  if (item.schema !== TOOL_SCHEMA) {
    throw new Error(`Unsupported tool registration schema '${String(item.schema)}'.`);
  }
  if (!item.name || typeof item.name !== "string") {
    throw new Error("Tool registration field 'name' is required.");
  }
  if (!item.type || !["cli", "script", "service"].includes(item.type)) {
    throw new Error("Tool registration field 'type' must be cli, script, or service.");
  }
  if (typeof item.discovery !== "object" || item.discovery === null) {
    throw new Error("Tool registration field 'discovery' is required.");
  }
}

export async function readToolFile(file: string): Promise<ToolRegistration> {
  const raw = await readFile(file, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  assertToolRegistration(parsed);
  return parsed;
}

export async function listTools(root = process.cwd()) {
  const dir = registryRoot(root);
  try {
    const files = await readdir(dir);
    const jsonFiles = files.filter((file) => file.endsWith(".json")).sort();
    const tools = await Promise.all(jsonFiles.map(async (file) => {
      const fullPath = path.join(dir, file);
      const registration = await readToolFile(fullPath);
      return { file: fullPath, registration };
    }));
    return tools;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function getTool(name: string, root = process.cwd()) {
  const file = toolFile(root, name);
  return { file, registration: await readToolFile(file) };
}

export async function addTool(sourceFile: string, root = process.cwd(), alias?: string) {
  const registration = await readToolFile(path.resolve(sourceFile));
  const name = alias ?? registration.name;
  const dir = registryRoot(root);
  const output = toolFile(root, name);
  await mkdir(dir, { recursive: true });
  if (alias) {
    await writeFile(output, `${JSON.stringify({ ...registration, name }, null, 2)}\n`, "utf8");
  } else {
    await copyFile(path.resolve(sourceFile), output);
  }
  return { output, registration: alias ? { ...registration, name } : registration };
}

export async function removeTool(name: string, root = process.cwd()) {
  const file = toolFile(root, name);
  await rm(file);
  return { file };
}
