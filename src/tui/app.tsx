import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { loadConfig } from "../config.js";
import { listTools } from "../registry.js";
import { listTasks } from "../task.js";
import { listSubagentRuns } from "../agents.js";
import { summarizeAudit } from "../audit.js";
import { summarizeUsage } from "../usage.js";
import { runA2C2ARequest } from "../agent/task-runner.js";
import type { ToolRegistration } from "../types.js";
import { CommandHint, Header, Overview, StatusBar, ToolCallCard, ToolList } from "./components.js";

interface AppProps {
  toolName?: string;
  requestFile?: string;
}

export function App({ toolName, requestFile }: AppProps) {
  const { exit } = useApp();
  const [tools, setTools] = useState<Array<{ file: string; registration: ToolRegistration }>>([]);
  const [model, setModel] = useState({ small: "local-small", mode: "auto" });
  const [stats, setStats] = useState<Array<{ label: string; value: string | number; color?: string }>>([]);
  const [call, setCall] = useState<{ status: "idle" | "running" | "ok" | "failed"; stdout?: string; stderr?: string }>({ status: "idle" });

  useInput((input) => {
    if (input === "q") {
      exit();
    }
  }, { isActive: Boolean(process.stdin.isTTY && process.stdin.setRawMode) });

  useEffect(() => {
    void (async () => {
      const config = await loadConfig();
      const loadedTools = await listTools();
      const tasks = await listTasks();
      const subagents = await listSubagentRuns(undefined, { includeCompleted: true });
      const usage = await summarizeUsage();
      const audit = await summarizeAudit();
      setModel({ small: config.models.small.model, mode: config.models.routing.mode });
      setTools(loadedTools);
      setStats([
        { label: "tools registered", value: loadedTools.length, color: "green" },
        { label: "tasks configured", value: tasks.length, color: "cyan" },
        { label: "subagent runs", value: subagents.length, color: "yellow" },
        { label: "stale subagents", value: subagents.filter((run) => run.stale).length, color: "red" },
        { label: "model tokens", value: usage.small.total_tokens + usage.large.total_tokens, color: "magenta" },
        { label: "audit denies/failures", value: audit.denied, color: audit.denied > 0 ? "red" : "green" }
      ]);
    })();
  }, []);

  useEffect(() => {
    if (!toolName || !requestFile) {
      return;
    }
    setCall({ status: "running" });
    void runA2C2ARequest(toolName, requestFile)
      .then((result) => setCall({ status: result.code === 0 ? "ok" : "failed", stdout: result.stdout, stderr: result.stderr }))
      .catch((error: unknown) => setCall({ status: "failed", stderr: error instanceof Error ? error.message : String(error) }));
  }, [toolName, requestFile]);

  return (
    <Box flexDirection="column">
      <Header title="Cyborg-Agent" subtitle="Lightweight, low-cost, Node-first agent runtime" />
      <Overview stats={stats} />
      <ToolList tools={tools} />
      {toolName && requestFile ? <ToolCallCard title={`tool call ${toolName}`} status={call.status} stdout={call.stdout} stderr={call.stderr} /> : null}
      {!toolName ? <CommandHint /> : null}
      <StatusBar smallModel={model.small} mode={model.mode} />
    </Box>
  );
}
