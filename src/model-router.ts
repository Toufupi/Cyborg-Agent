import type { CyborgConfig } from "./config.js";

export type ModelRouteReason =
  | "default"
  | "manual"
  | "fallback"
  | "tool_creation"
  | "repair_failed";

export function chooseModel(config: CyborgConfig, reason: ModelRouteReason = "default") {
  const mode = config.models.routing.mode;
  if (mode === "large_only") {
    return config.models.large ?? config.models.small;
  }
  if (mode === "small_only") {
    return config.models.small;
  }
  if (reason === "fallback" || reason === "tool_creation" || reason === "repair_failed") {
    return config.models.large ?? config.models.small;
  }
  return config.models.small;
}
