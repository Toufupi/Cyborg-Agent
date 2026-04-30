import { describe, expect, it } from "vitest";
import { contextPressureFromTokens, estimateTextTokens } from "../src/context-budget.js";

describe("context budget", () => {
  it("estimates text tokens and pressure levels", () => {
    expect(estimateTextTokens("hello world")).toBeGreaterThan(0);
    expect(estimateTextTokens("改变世界")).toBeGreaterThanOrEqual(4);
    expect(contextPressureFromTokens(100, 1000).level).toBe("low");
    expect(contextPressureFromTokens(800, 1000).level).toBe("high");
    expect(contextPressureFromTokens(950, 1000).should_compact).toBe(true);
  });
});
