import { describe, expect, it } from "vitest";
import {
  assertPolicyDecision,
  checkInvocation,
  checkNetwork,
  checkWorkspacePath,
  checkTool,
  defaultPolicy,
  sanitizeEnv
} from "../src/policy.js";
import { withTempWorkspace } from "./helpers.js";

describe("policy", () => {
  it("allows safe default node invocations and denies shell commands", async () => {
    await withTempWorkspace(async (root) => {
      const policy = defaultPolicy();

      expect(checkInvocation(policy, { command: process.execPath }, root).allowed).toBe(true);
      expect(checkInvocation(policy, { command: "powershell" }, root).allowed).toBe(false);
      expect(() => assertPolicyDecision(checkInvocation(policy, { command: "cmd" }, root))).toThrow("denied command");
    });
  });

  it("denies cwd outside the workspace root", async () => {
    await withTempWorkspace(async (root) => {
      const policy = defaultPolicy();
      const decision = checkInvocation(policy, {
        command: process.execPath,
        cwd: "C:\\"
      }, root);

      expect(decision.allowed).toBe(false);
      expect(decision.scope).toBe("workspace.cwd");
    });
  });

  it("sanitizes environment variables with an allowlist and secret deny patterns", () => {
    const policy = defaultPolicy();
    const result = sanitizeEnv(policy, {
      CYBORG_SHELL: "1",
      CYBORG_TOOL_ISOLATED: "1",
      OPENAI_API_KEY: "secret",
      RANDOM_VALUE: "nope"
    });

    expect(result.allowed).toEqual({ CYBORG_SHELL: "1", CYBORG_TOOL_ISOLATED: "1" });
    expect(result.blocked).toEqual(["OPENAI_API_KEY", "RANDOM_VALUE"]);
  });

  it("checks filesystem paths against the workspace sandbox", async () => {
    await withTempWorkspace(async (root) => {
      const policy = defaultPolicy();

      expect(checkWorkspacePath(policy, "reports/out.html", root, "write").allowed).toBe(true);
      expect(checkWorkspacePath(policy, "..\\outside.txt", root, "write").allowed).toBe(false);
      expect(checkWorkspacePath(policy, "C:\\outside.txt", root, "read").allowed).toBe(false);
    });
  });

  it("supports explicit bypass-all mode for trusted local debugging", async () => {
    await withTempWorkspace(async (root) => {
      const policy = {
        ...defaultPolicy("danger"),
        security: {
          mode: "bypass-all" as const
        },
        commands: {
          allow: [],
          deny: ["node"]
        }
      };

      expect(checkInvocation(policy, { command: "powershell", cwd: "C:\\" }, root).allowed).toBe(true);
      expect(checkWorkspacePath(policy, "C:\\outside.txt", root, "write").allowed).toBe(true);
      expect(sanitizeEnv(policy, { OPENAI_API_KEY: "secret" }).allowed).toEqual({ OPENAI_API_KEY: "secret" });
    });
  });

  it("supports explicit tool allowlists", () => {
    const policy = {
      ...defaultPolicy(),
      tools: {
        allow: ["page-generator-cli"],
        deny: []
      }
    };

    expect(checkTool(policy, "page-generator-cli").allowed).toBe(true);
    expect(checkTool(policy, "unknown-tool").allowed).toBe(false);
  });

  it("checks network host allowlists", () => {
    const policy = {
      ...defaultPolicy(),
      network: {
        mode: "allow" as const,
        allow_hosts: ["export.arxiv.org"]
      }
    };

    expect(checkNetwork(policy, "https://export.arxiv.org/api/query").allowed).toBe(true);
    expect(checkNetwork(policy, "https://example.com")).toMatchObject({ allowed: false, scope: "network" });
  });
});
