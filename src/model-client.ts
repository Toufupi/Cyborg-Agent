import type { ModelProfile } from "./config.js";
import type { JsonValue } from "./types.js";

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelClient {
  completeJson(profile: ModelProfile, messages: ModelMessage[]): Promise<JsonValue>;
}

export class ModelRequestError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly url: string;
  readonly causeMessage?: string;

  constructor(input: {
    code: string;
    message: string;
    url: string;
    status?: number;
    cause?: unknown;
  }) {
    super(input.message);
    this.name = "ModelRequestError";
    this.code = input.code;
    this.status = input.status;
    this.url = input.url;
    this.causeMessage = input.cause instanceof Error ? input.cause.message : input.cause ? String(input.cause) : undefined;
  }
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

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: profile.model,
          messages,
          temperature: 0,
          response_format: { type: "json_object" }
        })
      });
    } catch (error) {
      throw new ModelRequestError({
        code: "model_connection_failed",
        message: `Model endpoint is not reachable: ${url.toString()}`,
        url: url.toString(),
        cause: error
      });
    }

    if (!response.ok) {
      throw new ModelRequestError({
        code: "model_http_error",
        message: `Model request failed: ${response.status} ${response.statusText}`,
        status: response.status,
        url: url.toString()
      });
    }

    const body = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new ModelRequestError({
        code: "model_empty_response",
        message: "Model response did not include message content.",
        url: url.toString()
      });
    }
    return parseJsonContent(content);
  }
}

export async function smokeModel(profile: ModelProfile, client: ModelClient = new OpenAICompatibleModelClient()) {
  const started = Date.now();
  try {
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
      base_url: profile.base_url,
      latency_ms: Date.now() - started,
      result
    };
  } catch (error) {
    return {
      ok: false,
      model: profile.model,
      base_url: profile.base_url,
      latency_ms: Date.now() - started,
      error: serializeModelError(error)
    };
  }
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

export function serializeModelError(error: unknown) {
  if (error instanceof ModelRequestError) {
    return {
      type: error.code,
      message: error.message,
      status: error.status,
      url: error.url,
      cause: error.causeMessage
    };
  }
  return {
    type: "model_error",
    message: error instanceof Error ? error.message : String(error)
  };
}

function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}
