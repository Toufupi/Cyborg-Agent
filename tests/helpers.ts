import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolRegistration } from "../src/types.js";

export async function withTempWorkspace<T>(fn: (root: string) => Promise<T>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cyborg-agent-test-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function writeJson(root: string, relativePath: string, value: unknown) {
  const file = path.join(root, relativePath);
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return file;
}

export function fakeToolRegistration(overrides: Partial<ToolRegistration> = {}): ToolRegistration {
  return {
    schema: "a2c2a.tool-registration.v0.1",
    name: "fake-tool",
    version: "0.1.0",
    type: "cli",
    description: "A deterministic fake tool for tests.",
    runtime: {
      type: "node",
      node: ">=20",
      requires_cyborg_shell: true
    },
    discovery: {
      strategy: "static",
      a2c2a: {
        command: process.execPath,
        args: ["-e", "process.stdin.pipe(process.stdout)"]
      }
    },
    capabilities: {
      domains: ["test"]
    },
    ...overrides
  };
}
