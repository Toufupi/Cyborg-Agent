#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import React from "react";
import { render } from "ink";
import { App } from "../tui/app.js";
import { initConfig, loadConfig } from "../config.js";
import { chooseModel, type ModelRouteReason } from "../model-router.js";
import { addTool, getTool, listTools, removeTool } from "../registry.js";
import { runInvocation } from "../runner.js";
import { cyborgEnv } from "../runtime.js";
import { addTask, listTasks } from "../task.js";
import { runTask } from "../agent/task-runner.js";
import { runAgentGoal } from "../agent/planner.js";
import { buildToolIndex } from "../agent/tool-context.js";
import { listRuns } from "../session.js";
import { startAgentShell } from "../agent/shell.js";
import { addHook, listHooks } from "../hooks.js";
import { addAgentProfile, cancelSubagentStatus, listAgentProfiles, listSubagentRuns, loadSubagentStatus, runSubagent, runToolBuilderSubagent } from "../agents.js";
import { loadA2ATranscript } from "../a2a.js";
import { addPolicy, listPolicies, loadPolicy } from "../policy.js";
import { listApprovals, resolveApproval } from "../approvals.js";
import { doctorCyborg } from "../doctor.js";
import { describeToolEnv, doctorTool, installTool, prepareToolEnv, prepareToolInvocation } from "../tool-runtime.js";
import { smokeModel } from "../model-client.js";
import { installMarketplaceTool, listMarketplaceTools } from "../marketplace.js";
import { readAuditEvents, summarizeAudit } from "../audit.js";
import { requestSchedulerStop, runDueTasks, schedulerStatus, watchDueTasks } from "../scheduler.js";
import { addMemory, extractMemoriesFromRun, listMemories, searchMemories, type MemoryType } from "../memory.js";
import { summarizeUsage } from "../usage.js";
import { runPlannerEval } from "../evals/planner-eval.js";

const program = new Command();

if (process.argv.length <= 2) {
  await startAgentShell();
  process.exit(0);
}

program
  .name("cyborg")
  .description("Open a persistent Cyborg-Agent shell, or manage self-describing A2C2A tools.")
  .version("0.1.0");

program.command("chat")
  .alias("shell")
  .description("Open the persistent Cyborg-Agent interactive shell.")
  .action(async () => {
    await startAgentShell();
  });

program.command("init")
  .description("Create a default .cyborg/config.json.")
  .action(async () => {
    const result = await initConfig();
    console.log(JSON.stringify({ ok: true, output: result.file }, null, 2));
  });

program.command("config")
  .description("Print effective Cyborg-Agent config.")
  .action(async () => {
    console.log(JSON.stringify(redactSecrets(await loadConfig()), null, 2));
  });

program.command("model")
  .option("--reason <reason>", "Route reason: default, fallback, tool_creation, repair_failed, manual", "default")
  .option("--smoke", "Call the selected OpenAI-compatible model and expect a JSON response.")
  .description("Print selected model profile for a route reason.")
  .action(async (options: { reason: ModelRouteReason; smoke?: boolean }) => {
    const config = await loadConfig();
    const model = chooseModel(config, options.reason);
    if (options.smoke) {
      const smoke = await smokeModel(model);
      console.log(JSON.stringify({ ok: smoke.ok, smoke }, null, 2));
      process.exitCode = smoke.ok ? 0 : 1;
      return;
    }
    console.log(JSON.stringify({ ok: true, model: redactSecrets(model) }, null, 2));
  });

program.command("env")
  .description("Print Cyborg shell environment variables.")
  .action(() => {
    console.log(JSON.stringify(cyborgEnv(process.cwd()), null, 2));
  });

program.command("doctor")
  .description("Check Cyborg-Agent config, registries, task references, and tool runtimes.")
  .action(async () => {
    const result = await doctorCyborg(process.cwd());
    console.log(JSON.stringify({ ok: result.ok, doctor: result }, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  });

program.command("ask")
  .argument("<goal...>", "Natural language goal for the Cyborg agent.")
  .option("--max-repair <count>", "Maximum A2C2A repair attempts", "1")
  .description("Ask the real Cyborg agent loop to plan, call tools or tasks, and repair structured errors.")
  .addHelpText("after", `

Examples:
  $ cyborg ask "run the research progress report"
  $ cyborg ask "use page-generator-cli to render a project page" --max-repair 2`)
  .action(async (goalParts: string[], options: { maxRepair: string }) => {
    const result = await runAgentGoal(goalParts.join(" "), process.cwd(), {
      maxRepairAttempts: Number.parseInt(options.maxRepair, 10)
    });
    console.log(JSON.stringify({ ok: true, agent: result }, null, 2));
  });

program.command("context")
  .description("Print compact context for small-model planning.")
  .option("--json", "Print JSON")
  .action(async (options: { json?: boolean }) => {
    const tools = await buildToolIndex();
    if (options.json) {
      console.log(JSON.stringify({ ok: true, tools }, null, 2));
      return;
    }
    tools.forEach((tool) => {
      console.log(`${tool.name}\t${tool.runtime}\t${tool.description}`);
    });
  });

program.command("tui")
  .option("--tool <name>", "Tool name to call")
  .option("--request <file>", "A2C2A request JSON file")
  .description("Open the lightweight Cyborg-Agent TUI.")
  .action((options: { tool?: string; request?: string }) => {
    render(<App toolName={options.tool} requestFile={options.request} />);
  });

const tool = program.command("tool")
  .description("Register, inspect, and call local tools.");

tool.command("add")
  .argument("<registrationFile>", "Tool registration JSON file")
  .option("--as <name>", "Register under a different tool name")
  .description("Add a tool registration to .cyborg/tools.")
  .addHelpText("after", `

Examples:
  $ cyborg tool add ..\\some-tool\\tool.json
  $ cyborg tool add ..\\some-tool\\tool.json --as report-tool`)
  .action(async (registrationFile: string, options: { as?: string }) => {
    const result = await addTool(registrationFile, process.cwd(), options.as);
    console.log(JSON.stringify({ ok: true, output: result.output, name: result.registration.name }, null, 2));
  });

tool.command("create")
  .argument("<name>", "New semantic tool name")
  .option("--description <text>", "Short tool description")
  .option("--category <name>", "Capability category", "generated")
  .option("--no-register", "Create files but do not register the tool.")
  .description("Create a local Node A2C2A tool through the built-in tool-builder subagent.")
  .addHelpText("after", `

Examples:
  $ cyborg tool create paper-ranker --description "Rank research papers" --category research
  $ cyborg tool create draft-tool --no-register`)
  .action(async (name: string, options: { description?: string; category: string; register?: boolean }) => {
    const result = await runToolBuilderSubagent(process.cwd(), {
      name,
      description: options.description,
      category: options.category,
      register: options.register
    });
    console.log(JSON.stringify({ ok: true, tool: result }, null, 2));
  });

tool.command("list")
  .description("List registered tools.")
  .option("--json", "Print full JSON registrations")
  .action(async (options: { json?: boolean }) => {
    const tools = await listTools();
    if (options.json) {
      console.log(JSON.stringify({ ok: true, tools }, null, 2));
      return;
    }
    if (tools.length === 0) {
      console.log("No tools registered.");
      return;
    }
    tools.forEach(({ registration }) => {
      console.log(`${registration.name}\t${registration.type}\t${registration.description ?? ""}`);
    });
  });

tool.command("info")
  .argument("<name>", "Registered tool name")
  .description("Print a registered tool definition.")
  .action(async (name: string) => {
    const { file, registration } = await getTool(name);
    console.log(JSON.stringify({ ok: true, file, registration }, null, 2));
  });

tool.command("help")
  .argument("<name>", "Registered tool name")
  .argument("[command]", "Optional command help key from discovery.commands")
  .description("Run a registered tool's help invocation.")
  .action(async (name: string, command?: string) => {
    const { registration } = await getTool(name);
    const invocation = command ? registration.discovery.commands?.[command] : registration.discovery.help;
    if (!invocation) {
      console.error(`No help invocation found for '${command ?? name}'.`);
      process.exitCode = 1;
      return;
    }
    const result = await runInvocation(prepareToolInvocation(registration, invocation, process.cwd()), {
      env: prepareToolEnv(registration, {}, process.cwd())
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.code ?? 0;
  });

tool.command("manifest")
  .argument("<name>", "Registered tool name")
  .description("Run a registered tool's machine-readable manifest invocation.")
  .action(async (name: string) => {
    const { registration } = await getTool(name);
    if (!registration.discovery.manifest) {
      console.error(`Tool '${name}' does not define discovery.manifest.`);
      process.exitCode = 1;
      return;
    }
    const result = await runInvocation(prepareToolInvocation(registration, registration.discovery.manifest, process.cwd()), {
      env: prepareToolEnv(registration, {}, process.cwd())
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.code ?? 0;
  });

tool.command("call")
  .argument("<name>", "Registered tool name")
  .option("--request <file>", "A2C2A request JSON file. Defaults to stdin.")
  .option("--tui", "Show the call in the Ink TUI")
  .description("Call a registered tool through its A2C2A stdin endpoint.")
  .addHelpText("after", `

Examples:
  $ cyborg tool call page-generator-cli --request examples\\a2c2a-render.json
  $ Get-Content -Raw request.json | cyborg tool call page-generator-cli`)
  .action(async (name: string, options: { request?: string; tui?: boolean }) => {
    if (options.tui) {
      render(<App toolName={name} requestFile={options.request} />);
      return;
    }
    const { registration } = await getTool(name);
    const invocation = registration.discovery.a2c2a ?? registration.protocols?.find((protocol) => protocol.name === "a2c2a")?.invocation;
    if (!invocation) {
      console.error(`Tool '${name}' does not define an A2C2A invocation.`);
      process.exitCode = 1;
      return;
    }
    const input = options.request ? await readFile(options.request, "utf8") : await readStdin();
    const result = await runInvocation(prepareToolInvocation(registration, invocation, process.cwd()), {
      input,
      env: prepareToolEnv(registration, cyborgEnv(process.cwd()), process.cwd()),
      cwd: process.cwd()
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.code ?? 0;
  });

tool.command("remove")
  .argument("<name>", "Registered tool name")
  .description("Remove a tool registration.")
  .action(async (name: string) => {
    const result = await removeTool(name);
    console.log(JSON.stringify({ ok: true, removed: result.file }, null, 2));
  });

tool.command("doctor")
  .argument("<name>", "Registered tool name")
  .description("Check a registered tool runtime isolation environment.")
  .action(async (name: string) => {
    const { registration } = await getTool(name);
    const result = await doctorTool(registration, process.cwd());
    console.log(JSON.stringify({ ok: result.ok, doctor: result }, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  });

tool.command("env")
  .argument("<name>", "Registered tool name")
  .description("Print the effective isolated runtime environment for a registered tool.")
  .action(async (name: string) => {
    const { registration } = await getTool(name);
    const invocation = registration.discovery.a2c2a
      ?? registration.discovery.manifest
      ?? registration.discovery.help;
    console.log(JSON.stringify({ ok: true, env: describeToolEnv(registration, invocation, process.cwd()) }, null, 2));
  });

tool.command("install")
  .argument("<name>", "Registered tool name")
  .description("Install a registered node tool inside its declared runtime cwd.")
  .action(async (name: string) => {
    const { registration } = await getTool(name);
    const result = await installTool(registration, process.cwd());
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.code ?? 0;
  });

tool.command("marketplace")
  .argument("<file>", "Marketplace JSON index")
  .option("--install <name>", "Install a tool registration from the marketplace")
  .option("--as <name>", "Register installed tool under an alias")
  .option("--json", "Print JSON")
  .description("List or install tool registrations from a Cyborg marketplace index.")
  .action(async (file: string, options: { install?: string; as?: string; json?: boolean }) => {
    if (options.install) {
      const result = await installMarketplaceTool(file, options.install, process.cwd(), options.as);
      console.log(JSON.stringify({ ok: true, marketplace: result }, null, 2));
      return;
    }
    const tools = await listMarketplaceTools(file);
    if (options.json) {
      console.log(JSON.stringify({ ok: true, tools }, null, 2));
      return;
    }
    if (tools.length === 0) {
      console.log("No marketplace tools found.");
      return;
    }
    tools.forEach((entry) => {
      console.log(`${entry.name}\t${entry.category}\t${entry.description ?? ""}\t${entry.registration}`);
    });
  });

const task = program.command("task")
  .description("Manage lightweight scheduled task configs.");

task.command("add")
  .argument("<file>", "Task JSON file")
  .description("Add a task config to .cyborg/tasks.")
  .action(async (file: string) => {
    const result = await addTask(file);
    console.log(JSON.stringify({ ok: true, output: result.output, name: result.task.name }, null, 2));
  });

task.command("list")
  .description("List task configs.")
  .option("--json", "Print JSON")
  .action(async (options: { json?: boolean }) => {
    const tasks = await listTasks();
    if (options.json) {
      console.log(JSON.stringify({ ok: true, tasks }, null, 2));
      return;
    }
    if (tasks.length === 0) {
      console.log("No tasks registered.");
      return;
    }
    tasks.forEach(({ task }) => {
      console.log(`${task.name}\t${task.model_profile}\t${task.goal}`);
    });
  });

task.command("run")
  .argument("<name>", "Task name")
  .description("Run a task config once and save run history.")
  .action(async (name: string) => {
    const result = await runTask(name);
    console.log(JSON.stringify({ ok: true, run: result.file }, null, 2));
  });

task.command("history")
  .argument("[name]", "Optional task name prefix")
  .option("--json", "Print JSON")
  .description("List saved task run history.")
  .action(async (name: string | undefined, options: { json?: boolean }) => {
    const runs = await listRuns(process.cwd(), name);
    if (options.json) {
      console.log(JSON.stringify({ ok: true, runs }, null, 2));
      return;
    }
    if (runs.length === 0) {
      console.log("No runs found.");
      return;
    }
    runs.forEach((run) => {
      console.log(`${run.id}\t${run.file}`);
    });
  });

task.command("schedule")
  .option("--once", "Run due scheduled tasks once and exit")
  .option("--watch", "Keep polling scheduled tasks")
  .option("--status", "Print scheduler daemon and task state")
  .option("--stop", "Request a running scheduler watcher to stop")
  .option("--interval <ms>", "Watch poll interval in milliseconds", "60000")
  .description("Run due scheduled tasks from .cyborg/tasks.")
  .action(async (options: { once?: boolean; watch?: boolean; status?: boolean; stop?: boolean; interval: string }) => {
    if (options.status) {
      const state = await schedulerStatus(process.cwd());
      console.log(JSON.stringify({ ok: true, scheduler: state }, null, 2));
      return;
    }
    if (options.stop) {
      const state = await requestSchedulerStop(process.cwd());
      console.log(JSON.stringify({ ok: true, scheduler: state.state }, null, 2));
      return;
    }
    if (options.watch) {
      await watchDueTasks(process.cwd(), Number.parseInt(options.interval, 10), undefined, (result) => {
        if (result.runs.length > 0 || result.errors.length > 0) {
          console.log(JSON.stringify({ ok: true, scheduler: result }, null, 2));
        }
      });
      return;
    }
    const result = await runDueTasks(process.cwd());
    console.log(JSON.stringify({ ok: true, scheduler: result }, null, 2));
  });

const hook = program.command("hook")
  .description("Manage lifecycle hooks around tasks, tools, and chat sessions.");

hook.command("add")
  .argument("<file>", "Hook JSON file")
  .description("Add a hook config to .cyborg/hooks.")
  .action(async (file: string) => {
    const result = await addHook(file);
    console.log(JSON.stringify({ ok: true, output: result.output, name: result.hook.name }, null, 2));
  });

hook.command("list")
  .description("List hook configs.")
  .option("--json", "Print JSON")
  .action(async (options: { json?: boolean }) => {
    const hooks = await listHooks();
    if (options.json) {
      console.log(JSON.stringify({ ok: true, hooks }, null, 2));
      return;
    }
    if (hooks.length === 0) {
      console.log("No hooks registered.");
      return;
    }
    hooks.forEach(({ hook }) => {
      console.log(`${hook.name}\t${hook.enabled ? "enabled" : "disabled"}\t${hook.events.join(",")}`);
    });
  });

const agent = program.command("agent")
  .description("Manage lightweight agent profiles and run constrained subagents.");

agent.command("add")
  .argument("<file>", "Agent profile JSON or Markdown file")
  .description("Add an agent profile to .cyborg/agents.")
  .action(async (file: string) => {
    const result = await addAgentProfile(file);
    console.log(JSON.stringify({ ok: true, output: result.output, name: result.profile.name }, null, 2));
  });

agent.command("list")
  .description("List agent profiles.")
  .option("--json", "Print JSON")
  .action(async (options: { json?: boolean }) => {
    const agents = await listAgentProfiles();
    if (options.json) {
      console.log(JSON.stringify({ ok: true, agents }, null, 2));
      return;
    }
    if (agents.length === 0) {
      console.log("No agents registered.");
      return;
    }
    agents.forEach(({ profile }) => {
      console.log(`${profile.name}\t${profile.model_profile}\t${profile.description ?? ""}`);
    });
  });

agent.command("run")
  .argument("<name>", "Agent profile name")
  .argument("<task>", "Task name")
  .option("--worker <mode>", "Worker mode: task or planner", "task")
  .description("Run a task through a constrained subagent profile.")
  .action(async (name: string, taskName: string, options: { worker: "task" | "planner" }) => {
    const result = await runSubagent(name, taskName, process.cwd(), { worker: options.worker });
    console.log(JSON.stringify({ ok: true, run: result.file }, null, 2));
  });

agent.command("runs")
  .option("--agent <name>", "Filter by agent profile name")
  .option("--all", "Include completed, failed, and cancelled runs")
  .option("--json", "Print JSON")
  .description("List subagent lifecycle runs and stale/running status.")
  .action(async (options: { agent?: string; all?: boolean; json?: boolean }) => {
    const runs = await listSubagentRuns(process.cwd(), {
      agent: options.agent,
      includeCompleted: options.all
    });
    if (options.json) {
      console.log(JSON.stringify({ ok: true, runs }, null, 2));
      return;
    }
    if (runs.length === 0) {
      console.log("No subagent runs found.");
      return;
    }
    runs.forEach((run) => {
      const progress = run.status.progress?.phase
        ? ` ${run.status.progress.phase}${run.status.progress.current_step ? `:${run.status.progress.current_step}` : ""}`
        : "";
      const marker = run.stale ? "stale" : run.live ? "live" : "done";
      console.log(`${run.run_id}\t${run.status.agent}\t${run.status.status}\t${marker}${progress}\t${run.file}`);
    });
  });

agent.command("transcript")
  .argument("<file>", "Path to an agent run directory, run.json, or a2a.json file")
  .description("Print an A2A transcript for a subagent run.")
  .action(async (file: string) => {
    const transcriptFile = resolveRunArtifact(file, "a2a.json");
    const transcript = await loadA2ATranscript(transcriptFile);
    console.log(JSON.stringify({ ok: true, transcript }, null, 2));
  });

agent.command("status")
  .argument("<file>", "Path to an agent run directory, run.json, or subagent-status.json file")
  .description("Print subagent lifecycle status for a run.")
  .action(async (file: string) => {
    const statusFile = resolveRunArtifact(file, "subagent-status.json");
    const status = await loadSubagentStatus(statusFile);
    console.log(JSON.stringify({ ok: true, status }, null, 2));
  });

agent.command("cancel")
  .argument("<file>", "Path to a subagent-status.json file or run directory")
  .description("Mark a subagent run as cancelled.")
  .action(async (file: string) => {
    const statusFile = resolveRunArtifact(file, "subagent-status.json");
    const status = await cancelSubagentStatus(statusFile);
    console.log(JSON.stringify({ ok: true, status }, null, 2));
  });

const policy = program.command("policy")
  .description("Manage lightweight security and permission policies.");

policy.command("add")
  .argument("<file>", "Policy JSON file")
  .description("Add a policy config to .cyborg/policies.")
  .action(async (file: string) => {
    const result = await addPolicy(file);
    console.log(JSON.stringify({ ok: true, output: result.output, name: result.policy.name }, null, 2));
  });

policy.command("list")
  .description("List policy configs.")
  .option("--json", "Print JSON")
  .action(async (options: { json?: boolean }) => {
    const policies = await listPolicies();
    if (options.json) {
      console.log(JSON.stringify({ ok: true, policies }, null, 2));
      return;
    }
    if (policies.length === 0) {
      console.log("No policies registered. Built-in default policy is active.");
      return;
    }
    policies.forEach(({ policy }) => {
      console.log(`${policy.name}\tcommands=${policy.commands.allow.join(",")}\ttools=${policy.tools.allow.join(",") || "*"}`);
    });
  });

policy.command("show")
  .argument("[name]", "Policy name", "default")
  .description("Print a policy config.")
  .action(async (name: string) => {
    console.log(JSON.stringify({ ok: true, policy: await loadPolicy(name) }, null, 2));
  });

const approval = program.command("approval")
  .description("Review and resolve pending execution approvals.");

approval.command("list")
  .option("--all", "Include resolved approvals")
  .option("--json", "Print JSON")
  .description("List approval requests.")
  .action(async (options: { all?: boolean; json?: boolean }) => {
    const approvals = await listApprovals(process.cwd(), options.all ? "all" : "pending");
    if (options.json) {
      console.log(JSON.stringify({ ok: true, approvals }, null, 2));
      return;
    }
    if (approvals.length === 0) {
      console.log("No approvals found.");
      return;
    }
    approvals.forEach(({ approval }) => {
      console.log(`${approval.id}\t${approval.status}\t${approval.scope}:${approval.subject}\t${approval.reason}`);
    });
  });

const audit = program.command("audit")
  .description("Inspect Cyborg security and execution audit events.");

audit.command("list")
  .option("--json", "Print JSON")
  .description("List audit events.")
  .action(async (options: { json?: boolean }) => {
    const events = await readAuditEvents(process.cwd());
    if (options.json) {
      console.log(JSON.stringify({ ok: true, events }, null, 2));
      return;
    }
    if (events.length === 0) {
      console.log("No audit events.");
      return;
    }
    events.forEach((event) => {
      console.log(`${event.time}\t${event.type}\t${event.decision ?? ""}\t${event.subject ?? ""}`);
    });
  });

audit.command("summary")
  .description("Summarize audit events by type and decision.")
  .action(async () => {
    console.log(JSON.stringify({ ok: true, audit: await summarizeAudit(process.cwd()) }, null, 2));
  });

program.command("usage")
  .option("--prefix <prefix>", "Run id prefix to summarize", "agent")
  .description("Summarize model token usage from saved agent runs.")
  .action(async (options: { prefix: string }) => {
    const usage = await summarizeUsage(process.cwd(), options.prefix);
    console.log(JSON.stringify({ ok: true, usage }, null, 2));
  });

const evalCommand = program.command("eval")
  .description("Run Cyborg quality evals for planner behavior and token efficiency.");

evalCommand.command("planner")
  .option("--dir <dir>", "Planner eval case directory", "evals/planner")
  .option("--live", "Call the configured model instead of using expected_plan fixtures.")
  .option("--output <file>", "Write the JSON eval report to a file.")
  .description("Evaluate planner JSON actions, target selection, hallucinations, and token usage.")
  .action(async (options: { dir: string; live?: boolean; output?: string }) => {
    const report = await runPlannerEval(process.cwd(), {
      dir: options.dir,
      live: options.live,
      output: options.output
    });
    console.log(JSON.stringify({ ok: report.ok, eval: report }, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  });

const memory = program.command("memory")
  .description("Manage lightweight persistent Cyborg memory.");

memory.command("add")
  .requiredOption("--type <type>", "Memory type: run_memory, tool_memory, procedure_memory, preference_memory, error_memory")
  .requiredOption("--title <text>", "Short memory title")
  .requiredOption("--summary <text>", "Memory summary")
  .option("--tag <tag...>", "Tags")
  .option("--tool <name>", "Related tool")
  .option("--task <name>", "Related task")
  .description("Add a structured memory record.")
  .action(async (options: { type: MemoryType; title: string; summary: string; tag?: string[]; tool?: string; task?: string }) => {
    const result = await addMemory(process.cwd(), {
      type: options.type,
      title: options.title,
      summary: options.summary,
      tags: options.tag ?? [],
      tool: options.tool,
      task: options.task
    });
    console.log(JSON.stringify({ ok: true, memory: result.memory, file: result.file }, null, 2));
  });

memory.command("list")
  .option("--json", "Print JSON")
  .description("List memory records.")
  .action(async (options: { json?: boolean }) => {
    const memories = await listMemories(process.cwd());
    if (options.json) {
      console.log(JSON.stringify({ ok: true, memories }, null, 2));
      return;
    }
    if (memories.length === 0) {
      console.log("No memories found.");
      return;
    }
    memories.forEach(({ memory }) => {
      console.log(`${memory.id}\t${memory.type}\t${memory.title}`);
    });
  });

memory.command("search")
  .argument("<query...>", "Search query")
  .option("--tool <name>", "Related tool")
  .option("--task <name>", "Related task")
  .option("--tag <tag...>", "Tags")
  .option("--limit <count>", "Maximum results", "5")
  .description("Search relevant memory records for planner context.")
  .action(async (queryParts: string[], options: { tool?: string; task?: string; tag?: string[]; limit: string }) => {
    const memories = await searchMemories(process.cwd(), {
      goal: queryParts.join(" "),
      tool: options.tool,
      task: options.task,
      tags: options.tag ?? [],
      limit: Number.parseInt(options.limit, 10)
    });
    console.log(JSON.stringify({ ok: true, memories }, null, 2));
  });

memory.command("extract")
  .argument("<run>", "Path to a run directory or run.json file")
  .description("Extract reusable error/tool memories from a saved agent run.")
  .action(async (run: string) => {
    const result = await extractMemoriesFromRun(process.cwd(), run);
    console.log(JSON.stringify({ ok: true, memory: result }, null, 2));
  });

approval.command("allow")
  .argument("<id>", "Approval id")
  .description("Allow a pending approval once.")
  .action(async (id: string) => {
    const result = await resolveApproval(process.cwd(), id, "allow-once");
    console.log(JSON.stringify({ ok: true, approval: result.approval }, null, 2));
  });

approval.command("deny")
  .argument("<id>", "Approval id")
  .description("Deny a pending approval.")
  .action(async (id: string) => {
    const result = await resolveApproval(process.cwd(), id, "deny");
    console.log(JSON.stringify({ ok: true, approval: result.approval }, null, 2));
  });

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

await program.parseAsync();

function resolveRunArtifact(input: string, artifact: "a2a.json" | "subagent-status.json") {
  if (input.endsWith(artifact)) {
    return input;
  }
  if (/run\.json$/i.test(input)) {
    return input.replace(/run\.json$/i, artifact);
  }
  return `${input.replace(/[\\/]$/, "")}\\${artifact}`;
}

function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item)) as T;
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = key.toLowerCase().includes("api_key") && typeof item === "string"
        ? "<redacted>"
        : redactSecrets(item);
    }
    return result as T;
  }
  return value;
}
