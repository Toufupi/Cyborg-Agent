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
    since: typeof input.since === "string" ? input.since : undefined,
    timeoutMs: Number.isInteger(Number(input.timeoutMs)) ? Math.max(1000, Math.min(Number(input.timeoutMs), 30000)) : 8000
  };
}

async function fetchResearchItems(input) {
  const batches = await Promise.all(input.sources.map((source) => fetchSource(source, input)));
  return dedupe(batches.flat()).slice(0, input.limit);
}

async function fetchSource(source, input) {
  if (source === "sample") {
    return sampleItems(input.topic);
  }
  if (source === "arxiv") {
    return fetchArxiv(input.topic, input.timeoutMs);
  }
  if (source.startsWith("arxiv:")) {
    return fetchArxiv(source.slice("arxiv:".length) || input.topic, input.timeoutMs);
  }
  if (source.startsWith("rss:")) {
    return fetchRss(source.slice("rss:".length), input.timeoutMs);
  }
  if (source.startsWith("github:")) {
    return fetchGitHub(source.slice("github:".length) || input.topic, input.timeoutMs);
  }
  if (/^https?:\/\//i.test(source)) {
    return fetchRss(source, input.timeoutMs);
  }
  return [];
}

async function fetchArxiv(query, timeoutMs) {
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=5&sortBy=submittedDate&sortOrder=descending`;
  const xml = await fetchText(url, timeoutMs);
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => {
    const entry = match[1];
    const title = textTag(entry, "title");
    const summary = textTag(entry, "summary");
    const date = textTag(entry, "published").slice(0, 10);
    const link = /<id>([\s\S]*?)<\/id>/.exec(entry)?.[1]?.trim() ?? "";
    return {
      title,
      source: "arxiv",
      url: link,
      date,
      summary: compact(summary),
      relevance: score(title, summary, query),
      tags: ["arxiv", "paper"]
    };
  }).filter((item) => item.title);
}

async function fetchRss(url, timeoutMs) {
  const xml = await fetchText(url, timeoutMs);
  const itemMatches = [...xml.matchAll(/<(item|entry)>([\s\S]*?)<\/\1>/g)];
  return itemMatches.slice(0, 10).map((match) => {
    const item = match[2];
    const title = textTag(item, "title");
    const summary = textTag(item, "description") || textTag(item, "summary");
    const date = (textTag(item, "pubDate") || textTag(item, "updated") || textTag(item, "published")).slice(0, 24);
    const link = textTag(item, "link") || (/<link[^>]+href="([^"]+)"/.exec(item)?.[1] ?? "");
    return {
      title,
      source: "rss",
      url: link,
      date,
      summary: compact(summary),
      relevance: 0.7,
      tags: ["rss"]
    };
  }).filter((item) => item.title);
}

async function fetchGitHub(query, timeoutMs) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=5`;
  const json = JSON.parse(await fetchText(url, timeoutMs, { accept: "application/vnd.github+json" }));
  return (json.items ?? []).map((repo) => ({
    title: repo.full_name,
    source: "github",
    url: repo.html_url,
    date: repo.updated_at?.slice(0, 10) ?? "",
    summary: repo.description ?? "",
    relevance: Math.min(0.95, 0.6 + Math.log10((repo.stargazers_count ?? 0) + 1) / 10),
    tags: ["github", repo.language].filter(Boolean)
  }));
}

async function fetchText(url, timeoutMs, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "cyborg-agent-research-fetcher/0.1",
        ...headers
      }
    });
    if (!response.ok) {
      throw new Error(`Fetch failed for ${url}: ${response.status} ${response.statusText}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function textTag(xml, tag) {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml);
  return decodeXml(match?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, "").trim() ?? "");
}

function compact(value) {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function decodeXml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function score(title, summary, query) {
  const haystack = `${title} ${summary}`.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return 0.7;
  }
  const hits = terms.filter((term) => haystack.includes(term)).length;
  return Math.min(0.98, 0.6 + hits / terms.length * 0.35);
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
