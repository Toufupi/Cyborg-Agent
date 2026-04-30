import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, measureElement, useApp, useCursor, useInput, type DOMElement } from "ink";
import TextInput from "ink-text-input";
import logSymbols from "log-symbols";
import { listApprovals, resolveApproval, type ApprovalRequest } from "../approvals.js";
import { loadConfig } from "../config.js";
import { estimateSessionContextPressure, type ContextPressure } from "../context-budget.js";
import { listSubagentRuns } from "../agents.js";
import { summarizeAudit } from "../audit.js";
import { summarizeUsage } from "../usage.js";
import { loadPolicy } from "../policy.js";
import type { SessionEvent } from "../session.js";
import { createShellState, executeShellLineStream, type ShellState, type ShellStreamEvent, type StartShellOptions } from "../agent/shell.js";
import type { AgentPlan, AgentRunEvent } from "../agent/planner.js";
import { listTools } from "../registry.js";
import { listTasks } from "../task.js";
import { listAgentProfiles } from "../agents.js";
import { MatrixRain } from "./matrix-rain.js";

interface ChatAppProps extends StartShellOptions {
  root?: string;
}

type ChatRow =
  | { id: string; kind: "system" | "user" | "assistant" | "command" | "tool" | "error"; text: string; detail?: string; color?: string; step?: number };

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
  permissionMode: string;
  contextPressure: ContextPressure;
  busy: boolean;
}

export function ChatApp({ root = process.cwd(), resume, continueLatest, modelClient }: ChatAppProps) {
  const { exit } = useApp();
  const [state, setState] = useState<ShellState>();
  const [input, setInput] = useState("");
  const [rows, setRows] = useState<ChatRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | undefined>();
  const [completionHint, setCompletionHint] = useState("");
  const [introActive, setIntroActive] = useState(true);
  const [status, setStatus] = useState<ChatStatus>({
    session: "starting",
    resumed: false,
    smallModel: "loading",
    routing: "auto",
    tokens: 0,
    pendingApprovals: 0,
    auditDenied: 0,
    liveSubagents: 0,
    permissionMode: "workspace",
    contextPressure: {
      estimated_tokens: 0,
      max_tokens: 24000,
      used_ratio: 0,
      level: "low",
      should_compact: false
    },
    busy: false
  });
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);

  useEffect(() => {
    let active = true;
    const introTimer = setTimeout(() => setIntroActive(false), 2600);
    void (async () => {
      const shellState = await createShellState(root, { resume, continueLatest, modelClient });
      if (!active) {
        return;
      }
      setState(shellState);
      setHistory(historyFromSession(shellState.session.events));
      setRows([
        ...rowsFromSession(shellState.session.events),
        makeRow({
          kind: "system",
          text: shellState.resumed ? "Resumed Cyborg chat session." : "Started Cyborg chat session.",
          detail: "Type /help for commands, /exit to quit."
        })
      ]);
      await refreshStatus(shellState, setStatus, busy);
      await refreshApprovals(shellState, setApprovals);
    })().catch((error: unknown) => {
      pushRow(setRows, { kind: "error", text: error instanceof Error ? error.message : String(error) });
    });
    return () => {
      active = false;
      clearTimeout(introTimer);
    };
  }, [root, resume, continueLatest, modelClient]);

  useEffect(() => {
    if (!state) {
      return;
    }
    void refreshStatus(state, setStatus, busy);
    void refreshApprovals(state, setApprovals);
  }, [state, busy]);

  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      exit();
    }
    if (state && !busy && key.upArrow) {
      const nextIndex = historyIndex === undefined ? history.length - 1 : Math.max(0, historyIndex - 1);
      if (history[nextIndex]) {
        setInput(history[nextIndex]);
        setHistoryIndex(nextIndex);
      }
      return;
    }
    if (state && !busy && key.downArrow) {
      if (historyIndex === undefined) {
        return;
      }
      const nextIndex = historyIndex + 1;
      if (nextIndex >= history.length) {
        setInput("");
        setHistoryIndex(undefined);
        return;
      }
      setInput(history[nextIndex] ?? "");
      setHistoryIndex(nextIndex);
      return;
    }
    if (state && !busy && key.tab) {
      void completeInput(input, state).then((completed) => {
        if (!completed) {
          setCompletionHint("no completion");
          return;
        }
        setInput(completed);
        setCompletionHint(completed === input ? "already complete" : `completed ${completed}`);
      });
      return;
    }
    if (!state || approvals.length === 0 || busy || input.length > 0) {
      return;
    }
    if (_input === "a") {
      void decideApproval(state, approvals[0]!, "allow-once", setRows, setApprovals, setStatus);
    }
    if (_input === "d") {
      void decideApproval(state, approvals[0]!, "deny", setRows, setApprovals, setStatus);
    }
  });

  const visibleRows = useMemo(() => rows.slice(-18), [rows]);

  async function submit(value: string) {
    const line = value.trim();
    if (!line || busy || !state) {
      return;
    }
    setInput("");
    setCompletionHint("");
    setHistory((current) => [...current.filter((item) => item !== line), line].slice(-50));
    setHistoryIndex(undefined);
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
      <ChatHeader active={introActive || busy} status={{ ...status, busy }} />
      <Box flexDirection="column" minHeight={12}>
        {visibleRows.map((row) => <MessageRow key={row.id} row={row} />)}
      </Box>
      <ApprovalPanel approvals={approvals} />
      <ChatStatusLine status={{ ...status, busy }} />
      {completionHint ? <Text color="gray">{completionHint}</Text> : null}
      <AnchoredInputFrame input={input} busy={busy}>
        <Text color="green">cyborg</Text>
        <Text color="gray"> {busy ? "working" : "ready"} </Text>
        <TextInput value={input} onChange={setInput} onSubmit={submit} placeholder={busy ? "waiting for agent..." : "ask, /help, /tools, /exit"} />
      </AnchoredInputFrame>
    </Box>
  );
}

function AnchoredInputFrame({ children, input, busy }: { children: React.ReactNode; input: string; busy: boolean }) {
  const { setCursorPosition } = useCursor();
  const boxRef = useRef<DOMElement | null>(null);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) {
      setCursorPosition(undefined);
      return;
    }
    const { height } = measureElement(box);
    const top = box.yogaNode?.getComputedTop() ?? 0;
    const left = box.yogaNode?.getComputedLeft() ?? 0;
    const prompt = busy ? "cyborg working " : "cyborg ready ";
    setCursorPosition({
      x: Math.max(0, left + prompt.length + input.length + 2),
      y: Math.max(0, top + height - 2)
    });
    return () => setCursorPosition(undefined);
  }, [input, busy, setCursorPosition]);

  return (
    <Box ref={boxRef} borderStyle="single" borderColor={busy ? "yellow" : "gray"} paddingX={1} marginTop={1}>
      {children}
    </Box>
  );
}

function ChatHeader({ active, status }: { active: boolean; status: ChatStatus }) {
  const ctx = `${Math.round(status.contextPressure.used_ratio * 100)}%`;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1} paddingY={1} marginBottom={1}>
      <Box>
        <BinaryRobotLogo active={active} />
        <Box flexDirection="column" marginLeft={2} minWidth={34}>
          <Text>
            <Text bold color="green">Cyborg-Agent</Text>
            <Text color="gray"> / terminal agent shell</Text>
          </Text>
          <MatrixRain active={active} width={30} rows={4} />
        </Box>
        <Box flexDirection="column" marginLeft={3} minWidth={38}>
          <Text>
            <Text color={status.busy ? "yellow" : "green"} bold>{status.busy ? "RUNNING" : "READY"}</Text>
            <Text color="gray">  session </Text>
            <Text>{shortId(status.session)}{status.resumed ? "*" : ""}</Text>
          </Text>
          <Text>
            <Text color="gray">small </Text>
            <Text color="cyan">{compactModel(status.smallModel)}</Text>
            {status.largeModel ? <Text color="gray">  large </Text> : null}
            {status.largeModel ? <Text color="magenta">{compactModel(status.largeModel)}</Text> : null}
          </Text>
          <Text>
            <Text color="gray">mode </Text>
            <Text color="yellow">{status.routing}</Text>
            <Text color="gray">  perm </Text>
            <Text color={status.permissionMode === "bypass-all" ? "red" : "green"}>{compactPermission(status.permissionMode)}</Text>
          </Text>
          <Text>
            <Text color="gray">tok </Text>
            <Text>{status.tokens}</Text>
            <Text color="gray">  ctx </Text>
            <Text color={pressureColor(status.contextPressure.level)}>{ctx}</Text>
            <Text color="gray">  sub </Text>
            <Text>{status.liveSubagents}</Text>
            <Text color="gray">  app </Text>
            <Text color={status.pendingApprovals > 0 ? "yellow" : "green"}>{status.pendingApprovals}</Text>
          </Text>
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">{active ? "neural routing online" : "A2C2A-first, small-model friendly agent shell"}</Text>
      </Box>
    </Box>
  );
}

function BinaryRobotLogo({ active }: { active: boolean }) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => setTick((value) => value + 1), 90);
    return () => clearInterval(timer);
  }, [active]);

  const eye = active && tick % 4 === 0 ? "1" : "0";
  const antenna = active && tick % 2 === 0 ? "1" : "0";
  const lines = [
    `   ${antenna}   `,
    "  010  ",
    ` 1${eye}0${eye}1 `,
    " 10101 ",
    " 0   0 "
  ];

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index} color={index <= 1 ? "#00ff41" : index <= 3 ? "#00a83b" : "#005f26"} bold={index === 2}>
          {line}
        </Text>
      ))}
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
      <Text color={status.busy ? "yellow" : "green"}>{status.busy ? "run" : "idle"}</Text>
      <Text color="gray"> | denied </Text>
      <Text color={status.auditDenied > 0 ? "red" : "green"}>{status.auditDenied}</Text>
      <Text color="gray"> | press </Text>
      <Text color="cyan">/help</Text>
      <Text color="gray"> for commands, </Text>
      <Text color="cyan">/session</Text>
      <Text color="gray"> for transcript, </Text>
      <Text color="cyan">/exit</Text>
      <Text color="gray"> to quit</Text>
    </Box>
  );
}

function ApprovalPanel({ approvals }: { approvals: ApprovalRequest[] }) {
  if (approvals.length === 0) {
    return null;
  }
  const approval = approvals[0]!;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text color="yellow" bold>approval required</Text>
      <Text>{approval.scope}: {approval.subject}</Text>
      <Text color="gray">{approval.reason}</Text>
      <Text color="gray">press a allow once, d deny{approvals.length > 1 ? ` | ${approvals.length - 1} more pending` : ""}</Text>
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
    appendAgentEventRow(event.event, setRows);
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

function appendAgentEventRow(event: AgentRunEvent, setRows: React.Dispatch<React.SetStateAction<ChatRow[]>>) {
  const row = rowFromAgentEvent(event);
  if (!row) {
    return;
  }
  if (row.step === undefined) {
    pushRow(setRows, row);
    return;
  }
  setRows((current) => {
    const index = current.findIndex((item) => item.step === row.step);
    if (index < 0) {
      return [...current, makeRow(row, current.length)];
    }
    const next = [...current];
    next[index] = mergeStepRow(next[index]!, row);
    return next;
  });
}

function rowFromAgentEvent(event: AgentRunEvent): Omit<ChatRow, "id"> | undefined {
  if (event.type === "agent.start") {
    return { kind: "system", text: `planner started on ${event.model}`, detail: event.goal };
  }
  if (event.type === "agent.step.plan") {
    return { kind: "tool", step: event.step, text: `${logSymbols.info} step ${event.step}: ${describePlan(event.plan)}`, detail: `plan: ${event.plan.reason}` };
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
    return {
      kind: event.result.ok ? "tool" : "error",
      step: event.step,
      text: `${event.result.ok ? logSymbols.success : logSymbols.error} step ${event.step}: ${describePlan(event.plan)}`,
      detail: `result: ${compactOutput(event.result.output || JSON.stringify(event.result.observation))}`,
      color
    };
  }
  if (event.type === "agent.step.evaluation") {
    return {
      kind: event.decision === "stop" ? "error" : "tool",
      step: event.step,
      text: `step ${event.step}: ${event.decision}`,
      detail: `state: ${event.reason}`,
      color: event.decision === "stop" ? "red" : event.decision === "final" ? "green" : "yellow"
    };
  }
  if (event.type === "agent.error") {
    return { kind: "error", text: event.error.message, detail: event.error.type };
  }
  if (event.type === "agent.usage") {
    return { kind: "system", text: `usage small=${event.summary.small.total_tokens} large=${event.summary.large.total_tokens}` };
  }
  return undefined;
}

function mergeStepRow(existing: ChatRow, incoming: Omit<ChatRow, "id">): ChatRow {
  const details = [existing.detail, incoming.detail].filter(Boolean).join(" | ");
  return {
    ...existing,
    kind: incoming.kind,
    text: incoming.text,
    detail: details ? compactOutput(details, 900) : undefined,
    color: incoming.color ?? existing.color,
    step: incoming.step
  };
}

function rowsFromSession(events: SessionEvent[]) {
  return events
    .filter((event) => ["chat.user", "chat.assistant", "chat.error"].includes(event.type))
    .slice(-12)
    .map((event) => makeRow(rowFromSessionEvent(event)));
}

function historyFromSession(events: SessionEvent[]) {
  return events
    .filter((event) => event.type === "chat.user")
    .map((event) => event.message.trim())
    .filter(Boolean)
    .slice(-50);
}

function rowFromSessionEvent(event: SessionEvent): Omit<ChatRow, "id"> {
  if (event.type === "chat.user") {
    return { kind: "user", text: compactOutput(event.message) };
  }
  if (event.type === "chat.error") {
    return { kind: "error", text: compactOutput(event.message) };
  }
  return {
    kind: event.message.startsWith("[agent]") ? "assistant" : "command",
    text: firstLine(event.message.replace(/^\[agent]\s*/, "")),
    detail: restLines(event.message)
  };
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
  setRows((current) => [...current, makeRow(row, current.length)]);
}

function makeRow(row: Omit<ChatRow, "id">, index = 0): ChatRow {
  return { ...row, id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}` };
}

async function refreshStatus(state: ShellState, setStatus: React.Dispatch<React.SetStateAction<ChatStatus>>, busy: boolean) {
  const [config, usage, approvals, audit, subagents, policy] = await Promise.all([
    loadConfig(state.root),
    summarizeUsage(state.root),
    listApprovals(state.root, "pending"),
    summarizeAudit(state.root),
    listSubagentRuns(state.root),
    loadPolicy("default", state.root)
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
    permissionMode: policy.security.mode,
    contextPressure: estimateSessionContextPressure(state.session),
    busy
  });
}

async function refreshApprovals(state: ShellState, setApprovals: React.Dispatch<React.SetStateAction<ApprovalRequest[]>>) {
  setApprovals((await listApprovals(state.root, "pending")).map(({ approval }) => approval));
}

async function decideApproval(
  state: ShellState,
  approval: ApprovalRequest,
  decision: "allow-once" | "deny",
  setRows: React.Dispatch<React.SetStateAction<ChatRow[]>>,
  setApprovals: React.Dispatch<React.SetStateAction<ApprovalRequest[]>>,
  setStatus: React.Dispatch<React.SetStateAction<ChatStatus>>
) {
  await resolveApproval(state.root, approval.id, decision);
  pushRow(setRows, {
    kind: decision === "allow-once" ? "system" : "error",
    text: `${decision === "allow-once" ? "allowed" : "denied"} ${approval.id}`,
    detail: `${approval.scope}: ${approval.subject}`
  });
  await refreshApprovals(state, setApprovals);
  await refreshStatus(state, setStatus, false);
}

async function completeInput(value: string, state: ShellState) {
  const commands = [
    "/tools",
    "/tasks",
    "/hooks",
    "/agents",
    "/agent-runs",
    "/policies",
    "/approvals",
    "/context",
    "/session",
    "/doctor",
    "/model",
    "/run",
    "/history",
    "/call",
    "/tool-help",
    "/tool-doctor",
    "/tool-env",
    "/tool-install",
    "/agent-run",
    "/agent-status",
    "/a2a",
    "/allow",
    "/deny",
    "/exit"
  ];
  const trimmed = value.trimStart();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1 && !value.endsWith(" ")) {
    return firstCompletion(trimmed, commands);
  }
  const [command, partial = ""] = parts;
  if (command === "/run") {
    return completeSecondArg(value, partial, (await listTasks(state.root)).map(({ task }) => task.name));
  }
  if (["/call", "/tool-help", "/tool-doctor", "/tool-env", "/tool-install"].includes(command)) {
    return completeSecondArg(value, partial, (await listTools(state.root)).map(({ registration }) => registration.name));
  }
  if (["/agent-run"].includes(command)) {
    return completeSecondArg(value, partial, (await listAgentProfiles(state.root)).map(({ profile }) => profile.name));
  }
  return undefined;
}

function firstCompletion(partial: string, candidates: string[]) {
  const match = candidates.find((candidate) => candidate.startsWith(partial));
  return match ? `${match} ` : undefined;
}

function completeSecondArg(value: string, partial: string, candidates: string[]) {
  const match = candidates.find((candidate) => candidate.startsWith(partial));
  if (!match) {
    return undefined;
  }
  return value.replace(new RegExp(`${escapeRegExp(partial)}$`), match);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shortId(value: string) {
  return value.length > 12 ? value.slice(0, 12) : value;
}

function compactModel(value: string) {
  return value
    .replace(/^deepseek-/i, "ds-")
    .replace(/^gpt-/i, "g-")
    .slice(0, 18);
}

function compactPermission(value: string) {
  return value === "bypass-all" ? "bypass" : value === "workspace" ? "ws" : value;
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

function pressureColor(level: ContextPressure["level"]) {
  return level === "critical" ? "red" : level === "high" ? "yellow" : level === "medium" ? "cyan" : "green";
}
