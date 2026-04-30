import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolRegistration } from "./types.js";

export interface CreateNodeToolOptions {
  name: string;
  description?: string;
  category?: string;
}

export async function createNodeTool(root = process.cwd(), options: CreateNodeToolOptions) {
  const name = assertToolName(options.name);
  const toolRoot = path.join(path.resolve(root), "tools", name);
  await mkdir(path.join(toolRoot, "src"), { recursive: true });

  const packageJson = {
    name,
    version: "0.1.0",
    type: "module",
    private: true,
    scripts: {
      start: "node src/index.mjs"
    }
  };

  const script = [
    "let raw = '';",
    "process.stdin.on('data', chunk => { raw += chunk; });",
    "process.stdin.on('end', () => {",
    "  try {",
    "    const request = raw.trim() ? JSON.parse(raw) : {};",
    "    if (request.a2c2a !== '0.1' || typeof request.action !== 'string') {",
    "      console.log(JSON.stringify({ ok: false, a2c2a: '0.1', action: request.action ?? 'unknown', error: { type: 'request_format_error', message: 'Expected A2C2A request with a2c2a and action.' } }));",
    "      process.exit(1);",
    "    }",
    "    console.log(JSON.stringify({ ok: true, a2c2a: '0.1', action: request.action, result: { message: 'Tool scaffold is ready.', input: request.input ?? {} }, meta: request.meta ?? {} }));",
    "  } catch (error) {",
    "    console.log(JSON.stringify({ ok: false, a2c2a: '0.1', action: 'unknown', error: { type: 'json_parse_error', message: error instanceof Error ? error.message : String(error) } }));",
    "    process.exit(1);",
    "  }",
    "});",
    ""
  ].join("\n");

  const registration: ToolRegistration = {
    schema: "a2c2a.tool-registration.v0.1",
    name,
    version: "0.1.0",
    type: "cli",
    description: options.description ?? `Generated Cyborg tool ${name}.`,
    runtime: {
      type: "node",
      node: ">=20",
      cwd: toolRoot,
      package_manager: "npm",
      install_strategy: "external_repo",
      isolated: true,
      requires_cyborg_shell: true
    },
    discovery: {
      strategy: "static",
      a2c2a: {
        command: "node",
        args: ["src/index.mjs"],
        cwd: toolRoot
      },
      help: {
        command: "node",
        args: ["src/index.mjs"],
        cwd: toolRoot
      }
    },
    capabilities: {
      domains: [options.category ?? "generated"],
      categories: ["scaffold"]
    }
  };

  const packageFile = path.join(toolRoot, "package.json");
  const scriptFile = path.join(toolRoot, "src", "index.mjs");
  const registrationFile = path.join(toolRoot, "tool.json");
  await writeFile(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  await writeFile(scriptFile, script, "utf8");
  await writeFile(registrationFile, `${JSON.stringify(registration, null, 2)}\n`, "utf8");
  return { toolRoot, packageFile, scriptFile, registrationFile, registration };
}

function assertToolName(name: string) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error("Tool name must match /^[a-z][a-z0-9-]*$/.");
  }
  return name;
}
