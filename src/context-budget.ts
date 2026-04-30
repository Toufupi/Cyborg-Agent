import type { CyborgSession } from "./session.js";

export interface ContextPressure {
  estimated_tokens: number;
  max_tokens: number;
  used_ratio: number;
  level: "low" | "medium" | "high" | "critical";
  should_compact: boolean;
}

export function estimateTextTokens(value: string) {
  if (!value.trim()) {
    return 0;
  }
  const asciiWords = value.match(/[A-Za-z0-9_]+/g)?.length ?? 0;
  const cjkChars = value.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const punctuation = value.match(/[^\sA-Za-z0-9_\u3400-\u9fff]/g)?.length ?? 0;
  return Math.ceil(asciiWords * 1.25 + cjkChars + punctuation * 0.25);
}

export function estimateJsonTokens(value: unknown) {
  return estimateTextTokens(JSON.stringify(value));
}

export function contextPressureFromTokens(estimatedTokens: number, maxTokens = 24000): ContextPressure {
  const usedRatio = maxTokens > 0 ? estimatedTokens / maxTokens : 1;
  const level = usedRatio >= 0.9
    ? "critical"
    : usedRatio >= 0.7
      ? "high"
      : usedRatio >= 0.45
        ? "medium"
        : "low";
  return {
    estimated_tokens: estimatedTokens,
    max_tokens: maxTokens,
    used_ratio: Number(usedRatio.toFixed(3)),
    level,
    should_compact: usedRatio >= 0.7
  };
}

export function estimateSessionContextPressure(session: CyborgSession, maxTokens = 24000) {
  const chatEvents = session.events.filter((event) => ["chat.user", "chat.assistant", "chat.error"].includes(event.type));
  return contextPressureFromTokens(
    chatEvents.reduce((sum, event) => sum + estimateTextTokens(event.message), 0),
    maxTokens
  );
}

export function contextPressureJson(pressure: ContextPressure) {
  return {
    estimated_tokens: pressure.estimated_tokens,
    max_tokens: pressure.max_tokens,
    used_ratio: pressure.used_ratio,
    level: pressure.level,
    should_compact: pressure.should_compact
  };
}
