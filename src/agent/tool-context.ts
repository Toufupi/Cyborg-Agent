import { listTools } from "../registry.js";
import type { JsonValue } from "../types.js";

export async function buildToolIndex(root = process.cwd()) {
  const tools = await listTools(root);
  return tools.map(({ registration }) => ({
    name: registration.name,
    type: registration.type,
    description: registration.description ?? "",
    runtime: registration.runtime?.type ?? "unknown",
    domains: typeof registration.capabilities === "object" && registration.capabilities !== null && !Array.isArray(registration.capabilities)
      ? asJsonValue((registration.capabilities as Record<string, unknown>).domains)
      : null
  }));
}

function asJsonValue(value: unknown): JsonValue {
  if (value === undefined) {
    return null;
  }
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
