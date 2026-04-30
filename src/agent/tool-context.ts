import { listTools } from "../registry.js";

export async function buildToolIndex(root = process.cwd()) {
  const tools = await listTools(root);
  return tools.map(({ registration }) => ({
    name: registration.name,
    type: registration.type,
    description: registration.description ?? "",
    runtime: registration.runtime?.type ?? "unknown",
    domains: typeof registration.capabilities === "object" && registration.capabilities !== null && !Array.isArray(registration.capabilities)
      ? (registration.capabilities as Record<string, unknown>).domains
      : undefined
  }));
}
