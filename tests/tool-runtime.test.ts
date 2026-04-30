import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addTool, getTool } from "../src/registry.js";
import {
  describeToolEnv,
  doctorTool,
  prepareToolEnv,
  prepareToolInvocation,
  resolveToolRuntimeCwd
} from "../src/tool-runtime.js";
import { fakeToolRegistration, withTempWorkspace, writeJson } from "./helpers.js";

describe("tool runtime isolation", () => {
  it("resolves runtime cwd and preserves explicit invocation cwd", async () => {
    await withTempWorkspace(async (root) => {
      const toolRoot = path.join(root, "tools", "demo");
      const workspaceRoot = path.join(root, "workspace");
      await mkdir(toolRoot, { recursive: true });
      await mkdir(workspaceRoot, { recursive: true });
      const registration = fakeToolRegistration({
        name: "isolated-tool",
        runtime: {
          type: "node",
          cwd: toolRoot,
          package_manager: "npm",
          install_strategy: "external_repo",
          isolated: true
        },
        discovery: {
          strategy: "static",
          a2c2a: {
            command: process.execPath,
            args: ["tool.js"],
            cwd: workspaceRoot
          }
        }
      });

      expect(resolveToolRuntimeCwd(registration, root)).toBe(toolRoot);
      expect(prepareToolInvocation(registration, registration.discovery.a2c2a!, root).cwd).toBe(workspaceRoot);
    });
  });

  it("uses runtime cwd when invocation cwd is omitted", async () => {
    await withTempWorkspace(async (root) => {
      const toolRoot = path.join(root, "tool");
      await mkdir(toolRoot, { recursive: true });
      const registration = fakeToolRegistration({
        name: "runtime-cwd-tool",
        runtime: {
          type: "node",
          cwd: toolRoot,
          isolated: true
        }
      });

      expect(prepareToolInvocation(registration, { command: process.execPath }, root).cwd).toBe(toolRoot);
    });
  });

  it("prepares isolated node tool environment", async () => {
    await withTempWorkspace(async (root) => {
      const toolRoot = path.join(root, "tool");
      await mkdir(toolRoot, { recursive: true });
      const registration = fakeToolRegistration({
        name: "env-tool",
        runtime: {
          type: "node",
          cwd: toolRoot,
          package_manager: "npm",
          isolated: true
        }
      });

      const env = prepareToolEnv(registration, { PATH: "base-path", CYBORG_SHELL: "1" }, root);

      expect(env.CYBORG_TOOL_RUNTIME_CWD).toBe(toolRoot);
      expect(env.CYBORG_TOOL_ISOLATED).toBe("1");
      expect(env.CYBORG_SHELL).toBe("1");
      expect(env.PATH?.split(path.delimiter)[0]).toBe(path.join(toolRoot, "node_modules", ".bin"));
    });
  });

  it("describes effective tool runtime environment without leaking PATH", async () => {
    await withTempWorkspace(async (root) => {
      const toolRoot = path.join(root, "tool");
      await mkdir(toolRoot, { recursive: true });
      const registration = fakeToolRegistration({
        name: "summary-tool",
        runtime: {
          type: "node",
          cwd: toolRoot,
          package_manager: "npm",
          install_strategy: "external_repo",
          isolated: true,
          required_env: ["CYBORG_SHELL"]
        }
      });

      const summary = describeToolEnv(registration, { command: process.execPath }, root);

      expect(summary.tool).toBe("summary-tool");
      expect(summary.cwd).toBe(toolRoot);
      expect(summary.invocation_cwd).toBe(toolRoot);
      expect(summary.path_prepend).toEqual([path.join(toolRoot, "node_modules", ".bin")]);
      expect(summary.exported_env.CYBORG_TOOL_RUNTIME_CWD).toBe(toolRoot);
      expect(summary.exported_env.PATH).toBeUndefined();
      expect(summary.required_env).toEqual(["CYBORG_SHELL"]);
    });
  });

  it("fails fast when an isolated tool has no runtime cwd", () => {
    const registration = fakeToolRegistration({
      name: "broken-isolated-tool",
      runtime: {
        type: "node",
        isolated: true
      }
    });

    expect(() => prepareToolInvocation(registration, { command: process.execPath })).toThrow("runtime.cwd");
    expect(() => prepareToolEnv(registration)).toThrow("runtime.cwd");
  });

  it("doctors node tool environments", async () => {
    await withTempWorkspace(async (root) => {
      const toolRoot = path.join(root, "tool");
      await mkdir(path.join(toolRoot, "node_modules"), { recursive: true });
      await writeFile(path.join(toolRoot, "package.json"), JSON.stringify({ name: "demo-tool" }), "utf8");
      const source = await writeJson(root, "tool.json", fakeToolRegistration({
        name: "doctor-tool",
        runtime: {
          type: "node",
          cwd: toolRoot,
          package_manager: "npm",
          isolated: true
        }
      }));
      await addTool(source, root);

      const { registration } = await getTool("doctor-tool", root);
      const result = await doctorTool(registration, root);

      expect(result.ok).toBe(true);
      expect(result.cwd).toBe(toolRoot);
      expect(result.checks.map((check) => check.name)).toContain("node_modules");
    });
  });

  it("does not require node_modules when a node tool has no dependencies", async () => {
    await withTempWorkspace(async (root) => {
      const toolRoot = path.join(root, "tool");
      await mkdir(toolRoot, { recursive: true });
      await writeFile(path.join(toolRoot, "package.json"), JSON.stringify({ name: "no-deps-tool" }), "utf8");
      const registration = fakeToolRegistration({
        name: "no-deps-tool",
        runtime: {
          type: "node",
          cwd: toolRoot,
          package_manager: "npm",
          isolated: true
        }
      });

      const result = await doctorTool(registration, root);

      expect(result.ok).toBe(true);
      expect(result.checks.find((check) => check.name === "node_modules")?.message).toContain("not required");
    });
  });
});
