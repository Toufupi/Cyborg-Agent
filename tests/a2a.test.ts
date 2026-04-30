import { describe, expect, it } from "vitest";
import {
  appendA2AMessage,
  createA2AMessage,
  createA2ATranscript
} from "../src/a2a.js";

describe("A2A protocol", () => {
  it("creates validated messages and appends them to matching transcripts", () => {
    const transcript = createA2ATranscript("conversation-1");
    const message = createA2AMessage({
      conversationId: transcript.conversation_id,
      from: { agent: "cyborg", session_id: "parent-run" },
      to: { agent: "researcher" },
      type: "delegate",
      task: "research-progress",
      content: "Collect the latest research progress."
    });

    appendA2AMessage(transcript, message);

    expect(transcript.schema).toBe("cyborg.a2a.transcript.v0.1");
    expect(transcript.messages).toHaveLength(1);
    expect(transcript.messages[0]?.schema).toBe("cyborg.a2a.message.v0.1");
    expect(transcript.messages[0]?.type).toBe("delegate");
  });

  it("rejects messages from another conversation", () => {
    const transcript = createA2ATranscript("conversation-1");
    const message = createA2AMessage({
      conversationId: "conversation-2",
      from: { agent: "cyborg" },
      to: { agent: "researcher" },
      type: "delegate"
    });

    expect(() => appendA2AMessage(transcript, message)).toThrow("does not match transcript");
  });
});
