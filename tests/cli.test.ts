import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInvocation } from "../src/runner.js";
import { fakeToolRegistration, withTempWorkspace, writeJson } from "./helpers.js";

function cyborgInvocation(args: string[]) {
  return {
    command: process.execPath,
    args: [
      path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(process.cwd(), "src", "cli", "index.tsx"),
      ...args
    ]
  };
}

describe("cli", () => {
  it("prints top-level help for agent discovery", async () => {
    const result = await runInvocation(cyborgInvocation(["--help"]));

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Open a persistent Cyborg-Agent shell");
    expect(result.stdout).toContain("chat");
    expect(result.stdout).toContain("ask");
    expect(result.stdout).toContain("doctor");
    expect(result.stdout).toContain("tool");
    expect(result.stdout).toContain("task");
  });

  it("prints nested help for tool calls", async () => {
    const result = await runInvocation(cyborgInvocation(["tool", "call", "--help"]));

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Call a registered tool through its A2C2A stdin endpoint");
    expect(result.stdout).toContain("--request");
    expect(result.stdout).toContain("Examples:");
  });

  it("prints help for runtime isolation commands", async () => {
    const doctor = await runInvocation(cyborgInvocation(["tool", "doctor", "--help"]));
    const env = await runInvocation(cyborgInvocation(["tool", "env", "--help"]));
    const install = await runInvocation(cyborgInvocation(["tool", "install", "--help"]));

    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain("runtime isolation");
    expect(env.code).toBe(0);
    expect(env.stdout).toContain("effective isolated runtime environment");
    expect(install.code).toBe(0);
    expect(install.stdout).toContain("declared runtime cwd");
  });

  it("can add and list a registered tool from the CLI", async () => {
    await withTempWorkspace(async (root) => {
      const registrationFile = await writeJson(root, "tool.json", fakeToolRegistration({
        name: "cli-tool"
      }));

      const add = await runInvocation(cyborgInvocation(["tool", "add", registrationFile]), { cwd: root });
      expect(add.code).toBe(0);
      expect(add.stdout).toContain("\"name\": \"cli-tool\"");

      const list = await runInvocation(cyborgInvocation(["tool", "list", "--json"]), { cwd: root });
      expect(list.code).toBe(0);
      expect(list.stdout).toContain("\"name\": \"cli-tool\"");
      expect(list.stdout).toContain("\"schema\": \"a2c2a.tool-registration.v0.1\"");
    });
  });

  it("creates tools through the tool-builder subagent from the CLI", async () => {
    await withTempWorkspace(async (root) => {
      const create = await runInvocation(cyborgInvocation([
        "tool",
        "create",
        "cli-built-tool",
        "--description",
        "Created from CLI",
        "--category",
        "test"
      ]), { cwd: root });

      expect(create.code).toBe(0);
      expect(create.stdout).toContain("\"name\": \"cli-built-tool\"");
      expect(create.stdout).toContain("agent-tool-builder");
      expect(create.stdout).toContain("a2a.json");

      const list = await runInvocation(cyborgInvocation(["tool", "list", "--json"]), { cwd: root });
      expect(list.code).toBe(0);
      expect(list.stdout).toContain("\"name\": \"cli-built-tool\"");
    });
  });

  it("prints help for hook and agent commands", async () => {
    const hook = await runInvocation(cyborgInvocation(["hook", "--help"]));
    const agent = await runInvocation(cyborgInvocation(["agent", "--help"]));

    expect(hook.code).toBe(0);
    expect(hook.stdout).toContain("Manage lifecycle hooks");
    expect(hook.stdout).toContain("add");
    expect(hook.stdout).toContain("list");

    expect(agent.code).toBe(0);
    expect(agent.stdout).toContain("Manage lightweight agent profiles");
    expect(agent.stdout).toContain("run");
    expect(agent.stdout).toContain("transcript");
    expect(agent.stdout).toContain("status");

    const policy = await runInvocation(cyborgInvocation(["policy", "--help"]));
    expect(policy.code).toBe(0);
    expect(policy.stdout).toContain("Manage lightweight security");
    expect(policy.stdout).toContain("show");

    const approval = await runInvocation(cyborgInvocation(["approval", "--help"]));
    expect(approval.code).toBe(0);
    expect(approval.stdout).toContain("Review and resolve pending");
    expect(approval.stdout).toContain("allow");
    expect(approval.stdout).toContain("deny");
  });
});
