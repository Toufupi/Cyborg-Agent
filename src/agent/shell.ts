import { Buffer } from "node:buffer";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline";
import { loadA2ATranscript } from "../a2a.js";
import { listApprovals, resolveApproval } from "../approvals.js";
import { listAgentProfiles, loadSubagentStatus, runSubagent } from "../agents.js";
import { loadConfig } from "../config.js";
import { listHooks } from "../hooks.js";
import { doctorCyborg } from "../doctor.js";
import { chooseModel, type ModelRouteReason } from "../model-router.js";
import { listPolicies } from "../policy.js";
import { getTool, listTools } from "../registry.js";
import { runInvocation } from "../runner.js";
import { addEvent, createSession, listRuns, saveSession, type CyborgSession } from "../session.js";
import { listTasks } from "../task.js";
import { describeToolEnv, doctorTool, installTool, prepareToolEnv, prepareToolInvocation } from "../tool-runtime.js";
import { runA2C2ARequest, runTask } from "./task-runner.js";
import { buildToolIndex } from "./tool-context.js";

export interface ShellState {
  root: string;
  session: CyborgSession;
}

export interface ShellResult {
  output: string;
  exit?: boolean;
}

const routeReasons = new Set<ModelRouteReason>([
  "default",
  "manual",
  "fallback",
  "tool_creation",
  "repair_failed"
]);

export async function createShellState(root = process.cwd()): Promise<ShellState> {
  const session = await createSession(root, "chat");
  addEvent(session, "chat.start", "Started Cyborg interactive shell.");
  await saveSession(session);
  return { root, session };
}

export async function startAgentShell(root = process.cwd()) {
  const state = await createShellState(root);
  output.write([
    "Cyborg-Agent interactive shell",
    "Type /help for commands, /exit to quit.",
    `Session: ${state.session.id}`,
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
  if (line === "/exit" || line === "/quit" || line === "exit" || line === "quit") {
    return { output: "Bye. Session saved.", exit: true };
  }

  if (line === "/help" || line === "help" || line === "?") {
    return { output: helpText() };
  }

  if (line.startsWith("/")) {
    return runSlashCommand(line, state);
  }

  return runNaturalIntent(line, state);
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
    case "/policies":
      return { output: await formatPolicies(state.root) };
    case "/approvals":
      return { output: await formatApprovals(state.root) };
    case "/context":
      return { output: JSON.stringify({ ok: true, tools: await buildToolIndex(state.root) }, null, 2) };
    case "/doctor":
      return { output: JSON.stringify({ ok: true, doctor: await doctorCyborg(state.root) }, null, 2) };
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
    output: [
      "I am running in deterministic shell mode right now.",
      "Use /tools, /tasks, /hooks, /agents, /run <task>, /agent-run <agent> <task>, /call <tool> <request.json>, or /help.",
      "The small-model planner will plug into this same loop next."
    ].join("\n")
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

function helpText() {
  return [
    "Commands:",
    "  /tools                         List registered tools",
    "  /tasks                         List task configs",
    "  /hooks                         List lifecycle hooks",
    "  /agents                        List agent profiles",
    "  /policies                      List security policies",
    "  /approvals                     List pending approvals",
    "  /context                       Print compact tool context",
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
    "Natural language shortcuts are intentionally small for now:",
    "  list tools",
    "  list tasks",
    "  list hooks",
    "  list agents",
    "  list policies",
    "  list approvals",
    "  run task research-progress"
  ].join("\n");
}
