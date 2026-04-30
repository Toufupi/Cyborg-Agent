import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { loadConfig } from "../config.js";
import { listTools } from "../registry.js";
import { runA2C2ARequest } from "../agent/task-runner.js";
import type { ToolRegistration } from "../types.js";
import { Header, StatusBar, ToolCallCard, ToolList } from "./components.js";

interface AppProps {
  toolName?: string;
  requestFile?: string;
}

export function App({ toolName, requestFile }: AppProps) {
  const { exit } = useApp();
  const [tools, setTools] = useState<Array<{ file: string; registration: ToolRegistration }>>([]);
  const [model, setModel] = useState({ small: "local-small", mode: "auto" });
  const [call, setCall] = useState<{ status: "idle" | "running" | "ok" | "failed"; stdout?: string; stderr?: string }>({ status: "idle" });

  useInput((input) => {
    if (input === "q") {
      exit();
    }
  }, { isActive: Boolean(process.stdin.isTTY && process.stdin.setRawMode) });

  useEffect(() => {
    void (async () => {
      const config = await loadConfig();
      setModel({ small: config.models.small.model, mode: config.models.routing.mode });
      setTools(await listTools());
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
      <ToolList tools={tools} />
      {toolName && requestFile ? <ToolCallCard title={`tool call ${toolName}`} status={call.status} stdout={call.stdout} stderr={call.stderr} /> : null}
      {!toolName ? <Text color="gray">Run with --tool and --request to watch an A2C2A call.</Text> : null}
      <StatusBar smallModel={model.small} mode={model.mode} />
    </Box>
  );
}
