const A2C2A_VERSION = "0.1";

let raw = "";
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", async () => {
  try {
    const request = parseRequest(raw);
    if (request.action !== "research.fetch") {
      respondError(request, "action_not_found", `Unsupported action '${request.action}'.`);
      process.exit(1);
      return;
    }
    const input = validateInput(request);
    const items = await fetchResearchItems(input);
    respondSuccess(request, {
      topic: input.topic,
      count: items.length,
      items,
      metrics: {
        source_count: input.sources.length,
        requested_limit: input.limit,
        returned_count: items.length
      }
    });
  } catch (error) {
    if (error && error.a2c2aError) {
      console.log(JSON.stringify(error.a2c2aError));
      process.exit(1);
      return;
    }
    console.log(JSON.stringify({
      ok: false,
      a2c2a: A2C2A_VERSION,
      action: "research.fetch",
      error: {
        type: "runtime_error",
        message: error instanceof Error ? error.message : String(error)
      }
    }));
    process.exit(1);
  }
});

function parseRequest(value) {
  try {
    const request = JSON.parse(value);
    if (request.a2c2a !== A2C2A_VERSION || typeof request.action !== "string" || typeof request.input !== "object" || request.input === null) {
      throwA2C2A({
        ok: false,
        a2c2a: A2C2A_VERSION,
        action: request.action ?? "unknown",
        error: {
          type: "request_format_error",
          message: "Expected A2C2A request with a2c2a, action, and object input."
        },
        meta: request.meta ?? {}
      });
    }
    return request;
  } catch (error) {
    if (error && error.a2c2aError) {
      throw error;
    }
    throwA2C2A({
      ok: false,
      a2c2a: A2C2A_VERSION,
      action: "unknown",
      error: {
        type: "json_parse_error",
        message: error instanceof Error ? error.message : String(error)
      }
    });
  }
}

function validateInput(request) {
  const input = request.input;
  const issues = [];
  if (typeof input.topic !== "string" || input.topic.trim().length === 0) {
    issues.push({
      path: "$.input.topic",
      code: "missing_required",
      message: "topic is required.",
      expected: "non-empty string",
      actual: input.topic ?? null
    });
  }
  const sources = Array.isArray(input.sources) ? input.sources : ["sample"];
  if (!sources.every((source) => typeof source === "string" && source.length > 0)) {
    issues.push({
      path: "$.input.sources",
      code: "invalid_sources",
      message: "sources must be an array of non-empty strings.",
      expected: "string[]",
      actual: sources
    });
  }
  const limit = input.limit === undefined ? 5 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    issues.push({
      path: "$.input.limit",
      code: "value_out_of_range",
      message: "limit must be an integer from 1 to 20.",
      expected: { minimum: 1, maximum: 20 },
      actual: input.limit,
      metrics: { minimum: 1, maximum: 20, actual: input.limit ?? null }
    });
  }
  if (issues.length > 0) {
    throwA2C2A({
      ok: false,
      a2c2a: A2C2A_VERSION,
      action: request.action,
      error: {
        type: "input_validation_error",
        message: "research.fetch input is invalid.",
        details: { issues },
        hint: "Provide topic, optional sources, and a limit between 1 and 20."
      },
      meta: request.meta ?? {}
    });
  }
  return {
    topic: input.topic.trim(),
    sources,
    limit,
    since: typeof input.since === "string" ? input.since : undefined
  };
}

async function fetchResearchItems(input) {
  const sample = sampleItems(input.topic);
  const sourceSet = new Set(input.sources);
  const filtered = sample.filter((item) => sourceSet.has("sample") || sourceSet.has(item.source));
  return dedupe(filtered).slice(0, input.limit);
}

function sampleItems(topic) {
  const normalized = topic.toLowerCase();
  return [
    {
      title: `Tool-using agents improve repeatable ${topic} workflows`,
      source: "sample",
      url: "https://example.com/research/tool-using-agents",
      date: "2026-04-30",
      summary: "A structured tool loop reduces prompt size by moving repeatable work into executable code.",
      relevance: normalized.includes("agent") ? 0.95 : 0.78,
      tags: ["agents", "tools", "automation"]
    },
    {
      title: `Small-model orchestration for daily ${topic} monitoring`,
      source: "sample",
      url: "https://example.com/research/small-model-orchestration",
      date: "2026-04-29",
      summary: "A low-cost planner can drive deterministic code tools when manifests and errors are compact.",
      relevance: 0.9,
      tags: ["small-model", "scheduler", "a2c2a"]
    },
    {
      title: `Repairable JSON protocols for agent-code boundaries`,
      source: "sample",
      url: "https://example.com/research/repairable-json",
      date: "2026-04-28",
      summary: "Structured validation errors make tool calls easier for small language models to repair.",
      relevance: 0.88,
      tags: ["protocol", "validation", "repair"]
    }
  ];
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.url || item.title.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  }).sort((a, b) => b.relevance - a.relevance);
}

function respondSuccess(request, result) {
  console.log(JSON.stringify({
    ok: true,
    a2c2a: A2C2A_VERSION,
    action: request.action,
    result,
    meta: request.meta ?? {}
  }));
}

function respondError(request, type, message) {
  console.log(JSON.stringify({
    ok: false,
    a2c2a: A2C2A_VERSION,
    action: request.action ?? "unknown",
    error: { type, message },
    meta: request.meta ?? {}
  }));
}

function throwA2C2A(response) {
  const error = new Error(response.error.message);
  error.a2c2aError = response;
  throw error;
}
