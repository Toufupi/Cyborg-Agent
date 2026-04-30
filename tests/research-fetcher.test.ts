import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInvocation } from "../src/runner.js";

describe("research-fetcher tool", () => {
  it("returns A2C2A research items", async () => {
    const toolRoot = path.join(process.cwd(), "tools", "research-fetcher");
    const result = await runInvocation({
      command: process.execPath,
      args: ["src/index.mjs"],
      cwd: toolRoot
    }, {
      input: JSON.stringify({
        a2c2a: "0.1",
        action: "research.fetch",
        input: {
          topic: "agent tools",
          sources: ["sample"],
          limit: 2
        }
      })
    });

    const response = JSON.parse(result.stdout) as { ok: boolean; result: { count: number; items: unknown[] } };

    expect(result.code).toBe(0);
    expect(response.ok).toBe(true);
    expect(response.result.count).toBe(2);
    expect(response.result.items.length).toBe(2);
  });
});
