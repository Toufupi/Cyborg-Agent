import { describe, expect, it } from "vitest";
import { listApprovals, resolveApproval } from "../src/approvals.js";
import { runInvocation } from "../src/runner.js";
import { defaultPolicy } from "../src/policy.js";
import { withTempWorkspace } from "./helpers.js";

describe("approvals", () => {
  it("creates a pending approval in ask mode and consumes allow-once", async () => {
    await withTempWorkspace(async (root) => {
      const policy = {
        ...defaultPolicy("ask-policy"),
        commands: {
          allow: ["node"],
          deny: ["node"]
        },
        approvals: {
          mode: "ask" as const
        }
      };
      const invocation = {
        command: process.execPath,
        args: ["-e", "console.log('approved')"]
      };

      await expect(runInvocation(invocation, {
        cwd: root,
        workspaceRoot: root,
        policy
      })).rejects.toThrow("Approval required");

      const pending = await listApprovals(root);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.approval.scope).toBe("command");

      await resolveApproval(root, pending[0]!.approval.id, "allow-once");
      const result = await runInvocation(invocation, {
        cwd: root,
        workspaceRoot: root,
        policy
      });

      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("approved");
      const all = await listApprovals(root, "all");
      expect(all[0]?.approval.status).toBe("expired");
    });
  });

  it("keeps denying execution after a denied approval", async () => {
    await withTempWorkspace(async (root) => {
      const policy = {
        ...defaultPolicy("ask-policy"),
        commands: {
          allow: [],
          deny: ["node"]
        },
        approvals: {
          mode: "ask" as const
        }
      };
      const invocation = {
        command: process.execPath,
        args: ["-e", "console.log('nope')"]
      };

      await expect(runInvocation(invocation, { cwd: root, workspaceRoot: root, policy })).rejects.toThrow("Approval required");
      const pending = await listApprovals(root);
      await resolveApproval(root, pending[0]!.approval.id, "deny");

      await expect(runInvocation(invocation, { cwd: root, workspaceRoot: root, policy })).rejects.toThrow("Approval required");
      expect(await listApprovals(root)).toHaveLength(1);
    });
  });
});
