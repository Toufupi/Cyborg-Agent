import { describe, expect, it } from "vitest";
import { appendAuditEvent, readAuditEvents } from "../src/audit.js";
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
});
