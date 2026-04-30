import { Buffer } from "node:buffer";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline";
import { loadA2ATranscript } from "../a2a.js";
import { listApprovals, resolveApproval } from "../approvals.js";
import { listAgentProfiles, listSubagentRuns, loadSubagentStatus, runSubagent } from "../agents.js";
import { loadConfig } from "../config.js";
import { contextPressureJson, estimateSessionContextPressure } from "../context-budget.js";
import { listHooks } from "../hooks.js";
import { doctorCyborg } from "../doctor.js";
import { chooseModel, type ModelRouteReason } from "../model-router.js";
import { listPolicies } from "../policy.js";
import { getTool, listTools } from "../registry.js";
import { runInvocation } from "../runner.js";
import { addEvent, createSession, findLatestSession, listRuns, loadSession, saveSession, type CyborgSession } from "../session.js";
import { listTasks } from "../task.js";
import { describeToolEnv, doctorTool, installTool, prepareToolEnv, prepareToolInvocation } from "../tool-runtime.js";
import { runAgentGoal, runAgentGoalStream, type AgentRunEvent } from "./planner.js";
import { runA2C2ARequest, runTask } from "./task-runner.js";
import { buildToolIndex } from "./tool-context.js";
import type { ModelClient } from "../model-client.js";

export interface ShellState {
  root: string;
  session: CyborgSession;
  resumed: boolean;
  modelClient?: ModelClient;
}

export interface ShellResult {
  output: string;
  exit?: boolean;
}

export type ShellStreamEvent =
  | { type: "shell.user"; input: string }
  | { type: "shell.command.result"; output: string; exit?: boolean }
  | { type: "shell.agent.event"; event: AgentRunEvent }
  | { type: "shell.agent.result"; output: string; session: string; file: string }
  | { type: "shell.error"; output: string };

export type ShellLineClassification =
  | { kind: "empty" }
  | { kind: "exit" }
  | { kind: "command"; command: string }
  | { kind: "shortcut"; intent: "tools" | "tasks" | "hooks" | "agents" | "policies" | "approvals" | "context" | "history" | "run_task" }
  | { kind: "planner" };

const routeReasons = new Set<ModelRouteReason>([
  "default",
  "manual",
  "fallback",
  "tool_creation",
  "repair_failed"
]);

export interface StartShellOptions {
  resume?: string;
  continueLatest?: boolean;
  modelClient?: ModelClient;
  plain?: boolean;
}

export async function createShellState(root = process.cwd(), options: StartShellOptions = {}): Promise<ShellState> {
  const resumedSession = options.resume
    ? await loadSession(options.resume, root)
    : options.continueLatest
      ? await findLatestSession(root, "chat")
      : undefined;
  const session = resumedSession ?? await createSession(root, "chat");
  const resumed = Boolean(resumedSession);
  addEvent(session, resumed ? "chat.resume" : "chat.start", resumed ? "Resumed Cyborg interactive shell." : "Started Cyborg interactive shell.");
  await saveSession(session);
  return { root, session, resumed, modelClient: options.modelClient };
}

export async function startAgentShell(root = process.cwd(), options: StartShellOptions = {}) {
  if (input.isTTY && !options.plain) {
    const [{ default: React }, { render }, { ChatApp }] = await Promise.all([
      import("react"),
      import("ink"),
      import("../tui/chat-app.js")
    ]);
    const instance = render(React.createElement(ChatApp, {
      root,
      resume: options.resume,
      continueLatest: options.continueLatest,
      modelClient: options.modelClient
    }));
    await instance.waitUntilExit();
    return;
  }

  const state = await createShellState(root, options);
  output.write([
    "Cyborg-Agent",
    state.resumed ? "Resumed interactive agent shell." : "Interactive agent shell.",
    "Natural language goes to the planner. Slash commands stay deterministic.",
    "Type /help for commands, /session for context, /exit to quit.",
    `Session: ${state.session.id}${state.resumed ? " (resumed)" : ""}`,
    ""
  ].join("\n"));

  if (!input.isTTY) {
    await runPipedShellInput(state);
    return;
  }

  const rl = readline.createInterface({ input, output, prompt: "cyborg> " });
  try {
    rl.prompt();
    for await (const line of rl) {
      const result = await executeShellLine(line, state);
      if (result.output) {
        output.write(`${result.output}\n`);
      }
      if (result.exit) {
        break;
      }
      rl.prompt();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_USE_AFTER_CLOSE") {
      throw error;
    }
  } finally {
    addEvent(state.session, "chat.end", "Ended Cyborg interactive shell.");
    await saveSession(state.session);
    rl.close();
  }
}

async function runPipedShellInput(state: ShellState) {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const lines = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    output.write("cyborg> ");
    const result = await executeShellLine(line, state);
    if (result.output) {
      output.write(`${result.output}\n`);
    }
    if (result.exit) {
      break;
    }
  }
  addEvent(state.session, "chat.end", "Ended Cyborg interactive shell.");
  await saveSession(state.session);
}

export async function executeShellLine(line: string, state: ShellState): Promise<ShellResult> {
  const trimmed = line.trim();
  if (!trimmed) {
    return { output: "" };
  }

  addEvent(state.session, "chat.user", trimmed);
  try {
    const result = await dispatchLine(trimmed, state);
    addEvent(state.session, "chat.assistant", result.output, { exit: result.exit ?? false });
    await saveSession(state.session);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const outputText = `Error: ${message}`;
    addEvent(state.session, "chat.error", outputText);
    await saveSession(state.session);
    return { output: outputText };
  }
}

async function dispatchLine(line: string, state: ShellState): Promise<ShellResult> {
  const classification = classifyShellLine(line);
  if (classification.kind === "exit") {
    return { output: "Bye. Session saved.", exit: true };
  }

  if (classification.kind === "command" && classification.command === "/help") {
    return { output: helpText() };
  }

  if (classification.kind === "command") {
    return runSlashCommand(line, state);
  }

  return runNaturalIntent(line, state);
}

export async function* executeShellLineStream(line: string, state: ShellState): AsyncGenerator<ShellStreamEvent, ShellResult> {
  const trimmed = line.trim();
  if (!trimmed) {
    return { output: "" };
  }

  addEvent(state.session, "chat.user", trimmed);
  yield { type: "shell.user", input: trimmed };

  try {
    if (classifyShellLine(trimmed).kind !== "planner") {
      const result = await dispatchLine(trimmed, state);
      addEvent(state.session, "chat.assistant", result.output, { exit: result.exit ?? false });
      await saveSession(state.session);
      yield { type: "shell.command.result", output: result.output, exit: result.exit };
      return result;
    }

    const conversation = compactConversationContext(state.session);
    const stream = runAgentGoalStream(trimmed, state.root, {
      conversationContext: conversation,
      modelClient: state.modelClient
    });
    let next = await stream.next();
    while (!next.done) {
      yield { type: "shell.agent.event", event: next.value };
      next = await stream.next();
    }
    const result = next.value;
    const outputText = [
      "[agent]",
      result.output,
      "",
      `session: ${result.session}`,
      `run: ${result.file}`
    ].filter(Boolean).join("\n");
    addEvent(state.session, "chat.assistant", outputText, { exit: false });
    await saveSession(state.session);
    yield { type: "shell.agent.result", output: outputText, session: result.session, file: result.file };
    return { output: outputText };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const outputText = `Error: ${message}`;
    addEvent(state.session, "chat.error", outputText);
    await saveSession(state.session);
    yield { type: "shell.error", output: outputText };
    return { output: outputText };
  }
}

export function classifyShellLine(line: string): ShellLineClassification {
  const trimmed = line.trim();
  if (!trimmed) {
    return { kind: "empty" };
  }
  if (trimmed.startsWith("/")) {
    const [command] = splitArgs(trimmed);
    if (command === "/exit" || command === "/quit") {
      return { kind: "exit" };
    }
    return { kind: "command", command: command === "?" ? "/help" : command };
  }
  const lower = trimmed.toLowerCase();
  if (["exit", "quit", "help", "?"].includes(lower)) {
    return lower === "exit" || lower === "quit"
      ? { kind: "exit" }
      : { kind: "command", command: "/help" };
  }
  for (const intent of ["tools", "tasks", "hooks", "agents", "policies", "approvals"] as const) {
    if (lower.includes(`list ${intent}`) || lower.includes(`show ${intent}`)) {
      return { kind: "shortcut", intent };
    }
  }
  if (lower.includes("context")) {
    return { kind: "shortcut", intent: "context" };
  }
  if (lower.includes("history")) {
    return { kind: "shortcut", intent: "history" };
  }
  const words = splitArgs(trimmed);
  const runIndex = words.findIndex((word) => ["run", "task"].includes(word.toLowerCase()));
  if (runIndex >= 0 && words[runIndex + 1]) {
    return { kind: "shortcut", intent: "run_task" };
  }
  return { kind: "planner" };
}

async function runSlashCommand(line: string, state: ShellState): Promise<ShellResult> {
  const [command, ...args] = splitArgs(line);

  switch (command) {
    case "/tools":
      return { output: await formatTools(state.root) };
    case "/tasks":
      return { output: await formatTasks(state.root) };
    case "/hooks":
      return { output: await formatHooks(state.root) };
    case "/agents":
      return { output: await formatAgents(state.root) };
    case "/agent-runs":
      return { output: await formatAgentRuns(state.root, args) };
    case "/policies":
      return { output: await formatPolicies(state.root) };
    case "/approvals":
      return { output: await formatApprovals(state.root) };
    case "/context":
      return { output: JSON.stringify({ ok: true, tools: await buildToolIndex(state.root) }, null, 2) };
    case "/doctor":
      return { output: JSON.stringify({ ok: true, doctor: await doctorCyborg(state.root) }, null, 2) };
    case "/session":
      return { output: JSON.stringify({ ok: true, session: shellSessionSummary(state) }, null, 2) };
    case "/model":
      return { output: await formatModel(args[0], state.root) };
    case "/run":
      return runTaskCommand(args, state.root);
    case "/history":
      return { output: await formatHistory(args[0], state.root) };
    case "/call":
      return runCallCommand(args, state.root);
    case "/tool-help":
      return runToolHelpCommand(args, state.root);
    case "/tool-doctor":
      return runToolDoctorCommand(args, state.root);
    case "/tool-env":
      return runToolEnvCommand(args, state.root);
    case "/tool-install":
      return runToolInstallCommand(args, state.root);
    case "/agent-run":
      return runAgentCommand(args, state.root);
    case "/a2a":
      return runA2ACommand(args);
    case "/agent-status":
      return runAgentStatusCommand(args);
    case "/allow":
      return runApprovalDecisionCommand(args, state.root, "allow-once");
    case "/deny":
      return runApprovalDecisionCommand(args, state.root, "deny");
    default:
      return { output: `Unknown command '${command}'. Type /help for available commands.` };
  }
}

async function runNaturalIntent(line: string, state: ShellState): Promise<ShellResult> {
  const lower = line.toLowerCase();
  const words = splitArgs(line);

  if (lower.includes("list tools") || lower.includes("show tools")) {
    return { output: await formatTools(state.root) };
  }
  if (lower.includes("list tasks") || lower.includes("show tasks")) {
    return { output: await formatTasks(state.root) };
  }
  if (lower.includes("list hooks") || lower.includes("show hooks")) {
    return { output: await formatHooks(state.root) };
  }
  if (lower.includes("list agents") || lower.includes("show agents")) {
    return { output: await formatAgents(state.root) };
  }
  if (lower.includes("list policies") || lower.includes("show policies")) {
    return { output: await formatPolicies(state.root) };
  }
  if (lower.includes("list approvals") || lower.includes("show approvals")) {
    return { output: await formatApprovals(state.root) };
  }
  if (lower.includes("context")) {
    return { output: JSON.stringify({ ok: true, tools: await buildToolIndex(state.root) }, null, 2) };
  }
  if (lower.includes("history")) {
    return { output: await formatHistory(undefined, state.root) };
  }

  const runIndex = words.findIndex((word) => ["run", "task"].includes(word.toLowerCase()));
  if (runIndex >= 0 && words[runIndex + 1]) {
    return runTaskCommand([words[runIndex + 1]], state.root);
  }

  return {
    output: await runAgentIntent(line, state)
  };
}

async function runAgentIntent(line: string, state: ShellState) {
  const conversation = compactConversationContext(state.session);
  const result = await runAgentGoal(line, state.root, {
    conversationContext: conversation,
    modelClient: state.modelClient
  });
  return [
    "[agent]",
    result.output,
    "",
    `session: ${result.session}`,
    `run: ${result.file}`
  ].filter(Boolean).join("\n");
}

export function compactConversationContext(session: CyborgSession, limit = 12) {
  const messages = session.events
    .filter((event) => ["chat.user", "chat.assistant", "chat.error"].includes(event.type))
    .slice(-limit)
    .map((event) => ({
      role: event.type === "chat.user" ? "user" : event.type === "chat.assistant" ? "assistant" : "system",
      time: event.time,
      content: compactText(event.message, 1200)
    }));
  return {
    session_id: session.id,
    recent_messages: messages,
    message_count: session.events.filter((event) => ["chat.user", "chat.assistant", "chat.error"].includes(event.type)).length,
    context_pressure: contextPressureJson(estimateSessionContextPressure(session)),
    policy: {
      mode: "compact_recent_history",
      max_messages: limit,
      max_chars_per_message: 1200
    }
  };
}

function shellSessionSummary(state: ShellState) {
  const context = compactConversationContext(state.session);
  return {
    id: state.session.id,
    run_dir: state.session.runDir,
    resumed: state.resumed,
    events: state.session.events.length,
    context_pressure: contextPressureJson(estimateSessionContextPressure(state.session)),
    compact_context: context
  };
}

async function formatTools(root: string) {
  const tools = await listTools(root);
  if (tools.length === 0) {
    return "No tools registered.";
  }
  return tools.map(({ registration }) => {
    const runtime = registration.runtime?.type ?? "runtime?";
    const description = registration.description ? ` - ${registration.description}` : "";
    return `${registration.name} (${runtime})${description}`;
  }).join("\n");
}

async function formatTasks(root: string) {
  const tasks = await listTasks(root);
  if (tasks.length === 0) {
    return "No tasks registered.";
  }
  return tasks.map(({ task }) => `${task.name} [${task.model_profile}] - ${task.goal}`).join("\n");
}

async function formatHooks(root: string) {
  const hooks = await listHooks(root);
  if (hooks.length === 0) {
    return "No hooks registered.";
  }
  return hooks.map(({ hook }) => `${hook.name} [${hook.enabled ? "enabled" : "disabled"}] - ${hook.events.join(",")}`).join("\n");
}

async function formatAgents(root: string) {
  const agents = await listAgentProfiles(root);
  if (agents.length === 0) {
    return "No agents registered.";
  }
  return agents.map(({ profile }) => `${profile.name} [${profile.model_profile}] - ${profile.description ?? "no description"}`).join("\n");
}

async function formatAgentRuns(root: string, args: string[]) {
  const includeCompleted = args.includes("--all");
  const agentArgIndex = args.findIndex((arg) => arg === "--agent");
  const agent = agentArgIndex >= 0 ? args[agentArgIndex + 1] : undefined;
  const runs = await listSubagentRuns(root, { agent, includeCompleted });
  if (runs.length === 0) {
    return "No subagent runs found.";
  }
  return runs.map((run) => {
    const marker = run.stale ? "stale" : run.live ? "live" : "done";
    const progress = run.status.progress?.phase
      ? ` ${run.status.progress.phase}${run.status.progress.current_step ? `:${run.status.progress.current_step}` : ""}`
      : "";
    return `${run.run_id} [${run.status.agent}] ${run.status.status}/${marker}${progress}\n  ${run.file}`;
  }).join("\n");
}

async function formatPolicies(root: string) {
  const policies = await listPolicies(root);
  if (policies.length === 0) {
    return "No policies registered. Built-in default policy is active.";
  }
  return policies.map(({ policy }) => `${policy.name} - commands=${policy.commands.allow.join(",")} tools=${policy.tools.allow.join(",") || "*"}`).join("\n");
}

async function formatApprovals(root: string) {
  const approvals = await listApprovals(root, "pending");
  if (approvals.length === 0) {
    return "No pending approvals.";
  }
  return approvals.map(({ approval }) => `${approval.id} [${approval.status}] ${approval.scope}:${approval.subject} - ${approval.reason}`).join("\n");
}

async function formatModel(reasonArg: string | undefined, root: string) {
  const reason = routeReasons.has(reasonArg as ModelRouteReason) ? reasonArg as ModelRouteReason : "default";
  const config = await loadConfig(root);
  return JSON.stringify({ ok: true, reason, model: chooseModel(config, reason) }, null, 2);
}

async function formatHistory(prefix: string | undefined, root: string) {
  const runs = await listRuns(root, prefix);
  if (runs.length === 0) {
    return "No runs found.";
  }
  return runs.map((run) => `${run.id}\n  ${run.file}`).join("\n");
}

async function runTaskCommand(args: string[], root: string): Promise<ShellResult> {
  const taskName = args[0];
  if (!taskName) {
    return { output: "Usage: /run <task-name>" };
  }
  const result = await runTask(taskName, root);
  return { output: JSON.stringify({ ok: true, run: result.file }, null, 2) };
}

async function runCallCommand(args: string[], root: string): Promise<ShellResult> {
  const [toolName, requestFile] = args;
  if (!toolName || !requestFile) {
    return { output: "Usage: /call <tool-name> <request.json>" };
  }
  const result = await runA2C2ARequest(toolName, requestFile, root);
  const body = result.stdout.trim() || result.stderr.trim();
  return {
    output: [
      `exit_code: ${result.code ?? "unknown"}`,
      body
    ].filter(Boolean).join("\n")
  };
}

async function runToolHelpCommand(args: string[], root: string): Promise<ShellResult> {
  const [toolName, helpKey] = args;
  if (!toolName) {
    return { output: "Usage: /tool-help <tool-name> [command]" };
  }
  const { registration } = await getTool(toolName, root);
  const invocation = helpKey ? registration.discovery.commands?.[helpKey] : registration.discovery.help;
  if (!invocation) {
    return { output: `No help invocation found for '${helpKey ?? toolName}'.` };
  }
  const result = await runInvocation(prepareToolInvocation(registration, invocation, root), {
    cwd: root,
    env: prepareToolEnv(registration, {}, root)
  });
  return {
    output: [
      result.stdout.trim(),
      result.stderr.trim()
    ].filter(Boolean).join("\n")
  };
}

async function runToolDoctorCommand(args: string[], root: string): Promise<ShellResult> {
  const [toolName] = args;
  if (!toolName) {
    return { output: "Usage: /tool-doctor <tool-name>" };
  }
  const { registration } = await getTool(toolName, root);
  const result = await doctorTool(registration, root);
  return { output: JSON.stringify({ ok: result.ok, doctor: result }, null, 2) };
}

async function runToolEnvCommand(args: string[], root: string): Promise<ShellResult> {
  const [toolName] = args;
  if (!toolName) {
    return { output: "Usage: /tool-env <tool-name>" };
  }
  const { registration } = await getTool(toolName, root);
  const invocation = registration.discovery.a2c2a
    ?? registration.discovery.manifest
    ?? registration.discovery.help;
  return { output: JSON.stringify({ ok: true, env: describeToolEnv(registration, invocation, root) }, null, 2) };
}

async function runToolInstallCommand(args: string[], root: string): Promise<ShellResult> {
  const [toolName] = args;
  if (!toolName) {
    return { output: "Usage: /tool-install <tool-name>" };
  }
  const { registration } = await getTool(toolName, root);
  const result = await installTool(registration, root);
  return {
    output: [
      `exit_code: ${result.code ?? "unknown"}`,
      result.stdout.trim(),
      result.stderr.trim()
    ].filter(Boolean).join("\n")
  };
}

async function runAgentCommand(args: string[], root: string): Promise<ShellResult> {
  const [agentName, taskName] = args;
  if (!agentName || !taskName) {
    return { output: "Usage: /agent-run <agent-name> <task-name>" };
  }
  const result = await runSubagent(agentName, taskName, root);
  return { output: JSON.stringify({ ok: true, run: result.file }, null, 2) };
}

async function runA2ACommand(args: string[]): Promise<ShellResult> {
  const file = args[0];
  if (!file) {
    return { output: "Usage: /a2a <run-dir|run.json|a2a.json>" };
  }
  const transcriptFile = resolveRunArtifact(file, "a2a.json");
  const transcript = await loadA2ATranscript(transcriptFile);
  const lines = [
    `conversation: ${transcript.conversation_id}`,
    ...transcript.messages.map((message) => {
      const task = message.task ? ` task=${message.task}` : "";
      const content = message.content ? ` - ${message.content}` : "";
      return `${message.type} ${message.from.agent} -> ${message.to.agent}${task}${content}`;
    })
  ];
  return { output: lines.join("\n") };
}

async function runAgentStatusCommand(args: string[]): Promise<ShellResult> {
  const file = args[0];
  if (!file) {
    return { output: "Usage: /agent-status <run-dir|run.json|subagent-status.json>" };
  }
  const status = await loadSubagentStatus(resolveRunArtifact(file, "subagent-status.json"));
  return { output: JSON.stringify({ ok: true, status }, null, 2) };
}

async function runApprovalDecisionCommand(args: string[], root: string, decision: "allow-once" | "deny"): Promise<ShellResult> {
  const id = args[0];
  if (!id) {
    return { output: `Usage: /${decision === "allow-once" ? "allow" : "deny"} <approval-id>` };
  }
  const result = await resolveApproval(root, id, decision);
  return { output: JSON.stringify({ ok: true, approval: result.approval }, null, 2) };
}

function resolveRunArtifact(input: string, artifact: "a2a.json" | "subagent-status.json") {
  if (input.endsWith(artifact)) {
    return input;
  }
  if (/run\.json$/i.test(input)) {
    return input.replace(/run\.json$/i, artifact);
  }
  return `${input.replace(/[\\/]$/, "")}\\${artifact}`;
}

function splitArgs(line: string) {
  const matches = line.match(/"([^"]*)"|'([^']*)'|[^\s]+/g) ?? [];
  return matches.map((item) => {
    if ((item.startsWith("\"") && item.endsWith("\"")) || (item.startsWith("'") && item.endsWith("'"))) {
      return item.slice(1, -1);
    }
    return item;
  });
}

function compactText(value: string, maxChars: number) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxChars ? `${compact.slice(0, maxChars - 3)}...` : compact;
}

function helpText() {
  return [
    "Commands:",
    "  /tools                         List registered tools",
    "  /tasks                         List task configs",
    "  /hooks                         List lifecycle hooks",
    "  /agents                        List agent profiles",
    "  /agent-runs [--all]            List subagent lifecycle runs",
    "  /policies                      List security policies",
    "  /approvals                     List pending approvals",
    "  /context                       Print compact tool context",
    "  /session                       Show current chat session and compact context",
    "  /doctor                        Check config, tasks, tools, and runtimes",
    "  /model [reason]                Show selected model route",
    "  /run <task-name>               Run a task once",
    "  /history [task-prefix]         Show saved run history",
    "  /call <tool> <request.json>    Call a tool through A2C2A",
    "  /tool-help <tool> [command]    Run a registered tool help command",
    "  /tool-doctor <tool>            Check tool runtime isolation",
    "  /tool-env <tool>               Show effective tool runtime environment",
    "  /tool-install <tool>           Install a node tool in runtime cwd",
    "  /agent-run <agent> <task>      Run a task through a constrained subagent",
    "  /agent-status <run>            Show subagent lifecycle status",
    "  /a2a <run>                     Show a subagent A2A transcript",
    "  /allow <approval-id>           Allow a pending approval once",
    "  /deny <approval-id>            Deny a pending approval",
    "  /exit                          Quit",
    "",
    "Chat persistence:",
    "  cyborg chat --continue         Resume latest chat session",
    "  cyborg chat --resume <run>     Resume a specific chat run",
    "  Natural language planner calls include bounded recent chat context.",
    "",
    "Natural language shortcuts:",
    "  list tools",
    "  list tasks",
    "  list hooks",
    "  list agents",
    "  list policies",
    "  list approvals",
    "  run task research-progress",
    "",
    "Any other natural language line is sent to the Cyborg agent planner."
  ].join("\n");
}
