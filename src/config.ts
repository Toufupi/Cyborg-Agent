import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const ModelProfileSchema = z.object({
  base_url: z.string().min(1),
  api_key_env: z.string().min(1).optional(),
  model: z.string().min(1),
  role: z.enum(["small", "large"]).default("small")
});

export const ModelRoutingSchema = z.object({
  mode: z.enum(["small_only", "large_only", "auto", "manual"]).default("auto"),
  fallback_on: z.array(z.enum([
    "schema_repair_failed",
    "tool_not_found",
    "low_confidence",
    "max_retries_exceeded",
    "runtime_error"
  ])).default(["schema_repair_failed", "max_retries_exceeded", "runtime_error"])
});

export const CyborgConfigSchema = z.object({
  models: z.object({
    small: ModelProfileSchema,
    large: ModelProfileSchema.optional(),
    routing: ModelRoutingSchema.default({ mode: "auto", fallback_on: ["schema_repair_failed", "max_retries_exceeded", "runtime_error"] })
  }),
  workspace: z.object({
    root: z.string().min(1).default("."),
    tool_registry: z.string().min(1).default(".cyborg/tools"),
    runs_dir: z.string().min(1).default(".cyborg/runs"),
    tasks_dir: z.string().min(1).default(".cyborg/tasks")
  }).default({
    root: ".",
    tool_registry: ".cyborg/tools",
    runs_dir: ".cyborg/runs",
    tasks_dir: ".cyborg/tasks"
  })
});

export type CyborgConfig = z.output<typeof CyborgConfigSchema>;

export function configPath(root = process.cwd()) {
  return path.join(path.resolve(root), ".cyborg", "config.json");
}

export function defaultConfig(root = process.cwd()): CyborgConfig {
  return CyborgConfigSchema.parse({
    models: {
      small: {
        base_url: "http://localhost:11434/v1",
        model: "local-small",
        role: "small"
      },
      routing: {
        mode: "auto"
      }
    },
    workspace: {
      root: path.resolve(root),
      tool_registry: ".cyborg/tools",
      runs_dir: ".cyborg/runs",
      tasks_dir: ".cyborg/tasks"
    }
  });
}

export async function initConfig(root = process.cwd()) {
  const file = configPath(root);
  await mkdir(path.dirname(file), { recursive: true });
  const config = defaultConfig(root);
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { file, config };
}

export async function loadConfig(root = process.cwd()): Promise<CyborgConfig> {
  const file = configPath(root);
  try {
    return CyborgConfigSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultConfig(root);
    }
    throw error;
  }
}
