import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import logSymbols from "log-symbols";
import { listApprovals } from "../approvals.js";
import { loadConfig } from "../config.js";
import { listSubagentRuns } from "../agents.js";
import { summarizeAudit } from "../audit.js";
import { summarizeUsage } from "../usage.js";
import { createShellState, executeShellLineStream, type ShellState, type ShellStreamEvent, type StartShellOptions } from "../agent/shell.js";
import type { AgentPlan, AgentRunEvent } from "../agent/planner.js";

interface ChatAppProps extends StartShellOptions {
  root?: string;
}

type ChatRow =
  | { id: string; kind: "system" | "user" | "assistant" | "command" | "tool" | "error"; text: string; detail?: string; color?: string };

interface ChatStatus {
  session: string;
  resumed: boolean;
  smallModel: string;
  largeModel?: string;
  routing: string;
  tokens: number;
  pendingApprovals: number;
  auditDenied: number;
  liveSubagents: number;
  busy: boolean;
}

export function ChatApp({ root = process.cwd(), resume, continueLatest, modelClient }: ChatAppProps) {
  const { exit } = useApp();
  const [state, setState] = useState<ShellState>();
  const [input, setInput] = useState("");
  const [rows, setRows] = useState<ChatRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<ChatStatus>({
    session: "starting",
    resumed: false,
    smallModel: "loading",
    routing: "auto",
    tokens: 0,
    pendingApprovals: 0,
    auditDenied: 0,
    liveSubagents: 0,
    busy: false
  });

  useEffect(() => {
    let active = true;
    void (async () => {
      const shellState = await createShellState(root, { resume, continueLatest, modelClient });
      if (!active) {
        return;
      }
      setState(shellState);
      pushRow(setRows, {
        kind: "system",
        text: shellState.resumed ? "Resumed Cyborg chat session." : "Started Cyborg chat session.",
        detail: "Type /help for commands, /exit to quit."
      });
      await refreshStatus(shellState, setStatus, busy);
    })().catch((error: unknown) => {
      pushRow(setRows, { kind: "error", text: error instanceof Error ? error.message : String(error) });
    });
    return () => {
      active = false;
    };
  }, [root, resume, continueLatest, modelClient]);

  useEffect(() => {
    if (!state) {
      return;
    }
    void refreshStatus(state, setStatus, busy);
  }, [state, busy]);

  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      exit();
    }
  });

  const visibleRows = useMemo(() => rows.slice(-18), [rows]);

  async function submit(value: string) {
    const line = value.trim();
    if (!line || busy || !state) {
      return;
    }
    setInput("");
    setBusy(true);
    try {
      const stream = executeShellLineStream(line, state);
      let next = await stream.next();
      while (!next.done) {
        appendStreamEvent(next.value, setRows);
        next = await stream.next();
      }
      if (next.value.exit) {
        exit();
      }
    } finally {
      setBusy(false);
      await refreshStatus(state, setStatus, false);
    }
  }

  return (
    <Box flexDirection="column">
      <ChatHeader />
      <Box flexDirection="column" minHeight={12}>
        {visibleRows.map((row) => <MessageRow key={row.id} row={row} />)}
      </Box>
      <Box borderStyle="single" borderColor={busy ? "yellow" : "gray"} paddingX={1} marginTop={1}>
        <Text color="green">cyborg</Text>
        <Text color="gray"> {busy ? "working" : "ready"} </Text>
        <TextInput value={input} onChange={setInput} onSubmit={submit} placeholder={busy ? "waiting for agent..." : "ask, /help, /tools, /exit"} />
      </Box>
      <ChatStatusLine status={{ ...status, busy }} />
    </Box>
  );
}

function ChatHeader() {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1} marginBottom={1}>
      <Text bold color="green">Cyborg-Agent</Text>
      <Text color="gray">A2C2A-first, small-model friendly agent shell</Text>
    </Box>
  );
}

function MessageRow({ row }: { row: ChatRow }) {
  const label = {
    system: "system",
    user: "you",
    assistant: "agent",
    command: "command",
    tool: "tool",
    error: "error"
  }[row.kind];
  const color = row.color ?? {
    system: "gray",
    user: "cyan",
    assistant: "green",
    command: "blue",
    tool: "yellow",
    error: "red"
  }[row.kind];
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={color} bold>{label}</Text>
        <Text> {row.text}</Text>
      </Text>
      {row.detail ? <Text color="gray">  {row.detail}</Text> : null}
    </Box>
  );
}

function ChatStatusLine({ status }: { status: ChatStatus }) {
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
      <Text color={status.busy ? "yellow" : "green"}>{status.busy ? "running" : "idle"}</Text>
      <Text color="gray"> | session </Text>
      <Text>{shortId(status.session)}{status.resumed ? "*" : ""}</Text>
      <Text color="gray"> | small </Text>
      <Text color="cyan">{status.smallModel}</Text>
      {status.largeModel ? <Text color="gray"> | large </Text> : null}
      {status.largeModel ? <Text color="magenta">{status.largeModel}</Text> : null}
      <Text color="gray"> | route </Text>
      <Text color="yellow">{status.routing}</Text>
      <Text color="gray"> | tokens </Text>
      <Text>{status.tokens}</Text>
      <Text color="gray"> | approvals </Text>
      <Text color={status.pendingApprovals > 0 ? "yellow" : "green"}>{status.pendingApprovals}</Text>
      <Text color="gray"> | denies </Text>
      <Text color={status.auditDenied > 0 ? "red" : "green"}>{status.auditDenied}</Text>
      <Text color="gray"> | subagents </Text>
      <Text>{status.liveSubagents}</Text>
    </Box>
  );
}

function appendStreamEvent(event: ShellStreamEvent, setRows: React.Dispatch<React.SetStateAction<ChatRow[]>>) {
  if (event.type === "shell.user") {
    pushRow(setRows, { kind: "user", text: event.input });
    return;
  }
  if (event.type === "shell.command.result") {
    pushRow(setRows, { kind: "command", text: firstLine(event.output), detail: restLines(event.output) });
    return;
  }
  if (event.type === "shell.agent.event") {
    const row = rowFromAgentEvent(event.event);
    if (row) {
      pushRow(setRows, row);
    }
    return;
  }
  if (event.type === "shell.agent.result") {
    pushRow(setRows, { kind: "assistant", text: firstLine(event.output.replace(/^\[agent]\s*/, "")), detail: `run ${event.file}` });
    return;
  }
  if (event.type === "shell.error") {
    pushRow(setRows, { kind: "error", text: event.output });
  }
}

function rowFromAgentEvent(event: AgentRunEvent): Omit<ChatRow, "id"> | undefined {
  if (event.type === "agent.start") {
    return { kind: "system", text: `planner started on ${event.model}`, detail: event.goal };
  }
  if (event.type === "agent.step.plan") {
    return { kind: "tool", text: `${logSymbols.info} step ${event.step}: ${describePlan(event.plan)}`, detail: event.plan.reason };
  }
  if (event.type === "agent.repair") {
    return {
      kind: event.ok ? "tool" : "error",
      text: `${event.ok ? logSymbols.success : logSymbols.warning} repair ${event.attempt} via ${event.model}`,
      detail: event.error_type ? `error ${event.error_type}` : describePlan(event.plan)
    };
  }
  if (event.type === "agent.step.result") {
    const color = event.result.ok ? "green" : "red";
    return { kind: event.result.ok ? "tool" : "error", text: `${event.result.ok ? logSymbols.success : logSymbols.error} ${event.plan.kind}`, detail: compactOutput(event.result.output || JSON.stringify(event.result.observation)), color };
  }
  if (event.type === "agent.step.evaluation") {
    return { kind: "system", text: `state ${event.decision}`, detail: event.reason };
  }
  if (event.type === "agent.error") {
    return { kind: "error", text: event.error.message, detail: event.error.type };
  }
  if (event.type === "agent.usage") {
    return { kind: "system", text: `usage small=${event.summary.small.total_tokens} large=${event.summary.large.total_tokens}` };
  }
  return undefined;
}

function describePlan(plan: AgentPlan) {
  if (plan.kind === "call_tool") {
    return `call ${plan.tool}:${plan.request.action}`;
  }
  if (plan.kind === "run_task") {
    return `run task ${plan.task}`;
  }
  if (plan.kind === "inspect_tool") {
    return `inspect ${plan.tool}`;
  }
  if (plan.kind === "create_tool") {
    return `create tool ${plan.name}`;
  }
  return plan.kind;
}

function pushRow(setRows: React.Dispatch<React.SetStateAction<ChatRow[]>>, row: Omit<ChatRow, "id">) {
  setRows((current) => [...current, { ...row, id: `${Date.now()}-${current.length}` }]);
}

async function refreshStatus(state: ShellState, setStatus: React.Dispatch<React.SetStateAction<ChatStatus>>, busy: boolean) {
  const [config, usage, approvals, audit, subagents] = await Promise.all([
    loadConfig(state.root),
    summarizeUsage(state.root),
    listApprovals(state.root, "pending"),
    summarizeAudit(state.root),
    listSubagentRuns(state.root)
  ]);
  setStatus({
    session: state.session.id,
    resumed: state.resumed,
    smallModel: config.models.small.model,
    largeModel: config.models.large?.model,
    routing: config.models.routing.mode,
    tokens: usage.small.total_tokens + usage.large.total_tokens,
    pendingApprovals: approvals.length,
    auditDenied: audit.denied,
    liveSubagents: subagents.filter((run) => run.live).length,
    busy
  });
}

function shortId(value: string) {
  return value.length > 12 ? value.slice(0, 12) : value;
}

function firstLine(value: string) {
  return compactOutput(value.split(/\r?\n/)[0] ?? "");
}

function restLines(value: string) {
  const rest = value.split(/\r?\n/).slice(1).join("\n").trim();
  return rest ? compactOutput(rest, 900) : undefined;
}

function compactOutput(value: string, max = 240) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 3)}...` : compact;
}
