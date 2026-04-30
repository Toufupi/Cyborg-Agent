import { registryRoot } from "./registry.js";

export function cyborgEnv(root = process.cwd(), sessionId?: string) {
  return {
    CYBORG_SHELL: "1",
    CYBORG_WORKSPACE_ROOT: root,
    CYBORG_TOOL_REGISTRY: registryRoot(root),
    CYBORG_SESSION_ID: sessionId ?? `manual-${Date.now()}`
  };
}

export function isCyborgShell(env = process.env) {
  return env.CYBORG_SHELL === "1";
}
