import { listRuns } from "./session.js";

export interface UsageSummary {
  runs: number;
  model_calls: number;
  small: UsageBucket;
  large: UsageBucket;
  by_model: Record<string, UsageBucket>;
}

export interface UsageBucket {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export async function summarizeUsage(root = process.cwd(), prefix = "agent") {
  const runs = await listRuns(root, prefix);
  const summary: UsageSummary = {
    runs: 0,
    model_calls: 0,
    small: emptyBucket(),
    large: emptyBucket(),
    by_model: {}
  };
  for (const run of runs) {
    const events = (run.run as { events?: unknown[] }).events ?? [];
    const usageEvents = events.filter(isUsageEvent);
    if (usageEvents.length === 0) {
      continue;
    }
    summary.runs += 1;
    for (const event of usageEvents) {
      const data = event.data;
      summary.model_calls += 1;
      const role = data.role === "large" ? "large" : "small";
      addUsage(summary[role], data.usage);
      summary.by_model[data.model] ??= emptyBucket();
      addUsage(summary.by_model[data.model], data.usage);
    }
  }
  return summary;
}

function isUsageEvent(event: unknown): event is { type: "agent.model"; data: { model: string; role?: string; usage?: Partial<UsageBucket> } } {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return false;
  }
  const record = event as { type?: unknown; data?: unknown };
  if (record.type !== "agent.model" || !record.data || typeof record.data !== "object" || Array.isArray(record.data)) {
    return false;
  }
  return typeof (record.data as { model?: unknown }).model === "string";
}

function emptyBucket(): UsageBucket {
  return {
    calls: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0
  };
}

function addUsage(bucket: UsageBucket, usage: Partial<UsageBucket> | undefined) {
  bucket.calls += 1;
  bucket.prompt_tokens += usage?.prompt_tokens ?? 0;
  bucket.completion_tokens += usage?.completion_tokens ?? 0;
  bucket.total_tokens += usage?.total_tokens ?? 0;
}
