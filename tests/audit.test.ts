import { describe, expect, it } from "vitest";
import { appendAuditEvent, readAuditEvents, summarizeAudit } from "../src/audit.js";
import { withTempWorkspace } from "./helpers.js";

describe("audit log", () => {
  it("writes and reads jsonl audit events", async () => {
    await withTempWorkspace(async (root) => {
      await appendAuditEvent(root, {
        type: "policy.invocation",
        actor: "test",
        subject: "node",
        decision: "allow"
      });

      const events = await readAuditEvents(root);

      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("policy.invocation");
      expect(events[0]?.decision).toBe("allow");
    });
  });

  it("summarizes audit events by type and decision", async () => {
    await withTempWorkspace(async (root) => {
      await appendAuditEvent(root, {
        type: "policy.invocation",
        actor: "test",
        subject: "node",
        decision: "allow"
      });
      await appendAuditEvent(root, {
        type: "policy.invocation",
        actor: "test",
        subject: "cmd",
        decision: "deny"
      });
      await appendAuditEvent(root, {
        type: "scheduler.task.error",
        actor: "scheduler",
        decision: "failed"
      });

      const summary = await summarizeAudit(root);

      expect(summary.events).toBe(3);
      expect(summary.by_type["policy.invocation"]).toBe(2);
      expect(summary.by_decision.allow).toBe(1);
      expect(summary.denied).toBe(2);
      expect(summary.recent).toHaveLength(3);
    });
  });
});
