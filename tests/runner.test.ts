import { describe, expect, it } from "vitest";
import { runInvocation } from "../src/runner.js";

describe("runner", () => {
  it("runs node commands and captures stdout, stderr, and exit code", async () => {
    const result = await runInvocation({
      command: process.execPath,
      args: ["-e", "console.log('ok'); console.error('warn')"]
    });

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
    expect(result.stderr.trim()).toBe("warn");
  });

  it("passes stdin and custom environment variables", async () => {
    const result = await runInvocation({
      command: process.execPath,
      args: ["-e", "process.stdin.on('data', c => process.stdout.write(`${process.env.TEST_FLAG}:${c}`))"]
    }, {
      input: "hello",
      env: {
        TEST_FLAG: "cyborg"
      }
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("cyborg:hello");
  });
});
