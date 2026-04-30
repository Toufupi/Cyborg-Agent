import { mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listRuns } from "../src/session.js";
import { withTempWorkspace, writeJson } from "./helpers.js";

describe("sessions", () => {
  it("ignores incomplete run directories while listing runs", async () => {
    await withTempWorkspace(async (root) => {
      await mkdir(path.join(root, ".cyborg", "runs", "agent-incomplete"), { recursive: true });
      await mkdir(path.join(root, ".cyborg", "runs", "agent-complete"), { recursive: true });
      await writeJson(root, ".cyborg/runs/agent-complete/run.json", {
        id: "agent-complete",
        root,
        events: []
      });

      const runs = await listRuns(root, "agent");

      expect(runs.map((run) => run.id)).toEqual(["agent-complete"]);
    });
  });
});
