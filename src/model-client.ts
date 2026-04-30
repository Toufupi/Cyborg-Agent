import type { ModelProfile } from "./config.js";
import type { JsonValue } from "./types.js";

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelClient {
  completeJson(profile: ModelProfile, messages: ModelMessage[]): Promise<JsonValue>;
}

export class OpenAICompatibleModelClient implements ModelClient {
  async completeJson(profile: ModelProfile, messages: ModelMessage[]): Promise<JsonValue> {
    const url = new URL("chat/completions", ensureTrailingSlash(profile.base_url));
    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    if (profile.api_key_env) {
      const key = process.env[profile.api_key_env];
      if (key) {
        headers.authorization = `Bearer ${key}`;
      }
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: profile.model,
        messages,
        temperature: 0,
        response_format: { type: "json_object" }
      })
    });

    if (!response.ok) {
      throw new Error(`Model request failed: ${response.status} ${response.statusText}`);
    }

    const body = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Model response did not include message content.");
    }
    return parseJsonContent(content);
  }
}

export async function smokeModel(profile: ModelProfile, client: ModelClient = new OpenAICompatibleModelClient()) {
  const started = Date.now();
  const result = await client.completeJson(profile, [
    {
      role: "system",
      content: "Return exactly this JSON object and no markdown: {\"ok\":true,\"kind\":\"model_smoke\"}"
    },
    {
      role: "user",
      content: "model smoke test"
    }
  ]);
  return {
    ok: typeof result === "object" && result !== null && !Array.isArray(result) && result.ok === true,
    model: profile.model,
    latency_ms: Date.now() - started,
    result
  };
}

export function parseJsonContent(content: string): JsonValue {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      return JSON.parse(fenced[1]) as JsonValue;
    }
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(trimmed.slice(first, last + 1)) as JsonValue;
    }
    throw new Error("Model response was not valid JSON.");
  }
}

function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}
