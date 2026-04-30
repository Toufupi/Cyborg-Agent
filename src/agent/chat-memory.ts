import { addMemory, listMemories } from "../memory.js";
import type { CyborgSession, SessionEvent } from "../session.js";
import type { ContextPressure } from "../context-budget.js";

export interface AutoCompactResult {
  compacted: boolean;
  reason: string;
  memory?: {
    id: string;
    file: string;
    title: string;
  };
}

export async function maybeAutoCompactChatMemory(root: string, session: CyborgSession, pressure: ContextPressure): Promise<AutoCompactResult> {
  if (!pressure.should_compact) {
    return { compacted: false, reason: "context pressure below compaction threshold" };
  }
  const events = chatEvents(session.events);
  if (events.length < 8) {
    return { compacted: false, reason: "not enough chat turns to compact" };
  }
  const existing = await listMemories(root);
  const extractKey = `chat-auto-compact|${session.id}|${events.length}`;
  if (existing.some(({ memory }) => isRecord(memory.data) && memory.data.extract_key === extractKey)) {
    return { compacted: false, reason: "chat compaction already saved for this boundary" };
  }
  const summary = summarizeChatEvents(events.slice(0, -4));
  const created = await addMemory(root, {
    type: "run_memory",
    title: `Chat compact summary ${session.id.slice(0, 32)}`,
    summary,
    tags: ["chat", "auto-compact", pressure.level],
    source_run: session.runDir,
    data: {
      extract_key: extractKey,
      session_id: session.id,
      compacted_messages: Math.max(0, events.length - 4),
      context_pressure: {
        estimated_tokens: pressure.estimated_tokens,
        max_tokens: pressure.max_tokens,
        used_ratio: pressure.used_ratio,
        level: pressure.level
      }
    }
  });
  return {
    compacted: true,
    reason: "saved compact chat summary to memory",
    memory: {
      id: created.memory.id,
      file: created.file,
      title: created.memory.title
    }
  };
}

function chatEvents(events: SessionEvent[]) {
  return events.filter((event) => ["chat.user", "chat.assistant", "chat.error"].includes(event.type));
}

function summarizeChatEvents(events: SessionEvent[]) {
  const userGoals = events
    .filter((event) => event.type === "chat.user")
    .slice(-8)
    .map((event) => `- User: ${compact(event.message, 180)}`);
  const agentResults = events
    .filter((event) => event.type === "chat.assistant")
    .slice(-8)
    .map((event) => `- Agent: ${compact(event.message.replace(/^\[agent]\s*/, ""), 220)}`);
  return [
    "Automatically compacted chat summary. This is a short operational memory, not a verbatim transcript.",
    "",
    "Recent user goals:",
    ...userGoals,
    "",
    "Recent agent outputs:",
    ...agentResults
  ].join("\n").slice(0, 2000);
}

function compact(value: string, max: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
