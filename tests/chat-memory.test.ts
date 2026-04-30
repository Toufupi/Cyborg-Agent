import { describe, expect, it } from "vitest";
import { maybeAutoCompactChatMemory } from "../src/agent/chat-memory.js";
import { contextPressureFromTokens } from "../src/context-budget.js";
import { createSession, addEvent } from "../src/session.js";
import { listMemories } from "../src/memory.js";
import { withTempWorkspace } from "./helpers.js";

describe("chat memory compaction", () => {
  it("saves a compact summary only when context pressure is high", async () => {
    await withTempWorkspace(async (root) => {
      const session = await createSession(root, "chat");
      for (let index = 0; index < 10; index += 1) {
        addEvent(session, "chat.user", `make report ${index}`);
        addEvent(session, "chat.assistant", `[agent]\nreport ${index} done`);
      }

      const low = await maybeAutoCompactChatMemory(root, session, contextPressureFromTokens(100, 1000));
      const high = await maybeAutoCompactChatMemory(root, session, contextPressureFromTokens(800, 1000));
      const duplicate = await maybeAutoCompactChatMemory(root, session, contextPressureFromTokens(850, 1000));
      const memories = await listMemories(root);

      expect(low.compacted).toBe(false);
      expect(high.compacted).toBe(true);
      expect(duplicate.compacted).toBe(false);
      expect(memories).toHaveLength(1);
      expect(memories[0]?.memory.tags).toContain("auto-compact");
      expect(memories[0]?.memory.summary).toContain("not a verbatim transcript");
    });
  });
});
