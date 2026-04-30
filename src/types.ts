export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface Invocation {
  command: string;
  args?: string[];
  cwd?: string;
}

export interface ToolRuntime {
  type: "node" | "python" | "native" | "service";
  node?: string;
  python?: string;
  cwd?: string;
  package_manager?: "npm" | "pnpm" | "yarn";
  install_strategy?: "external_repo" | "tool_env" | "none";
  isolated?: boolean;
  requires_cyborg_shell?: boolean;
  required_env?: string[];
}

export interface ToolRegistration {
  schema: string;
  name: string;
  version?: string;
  type: "cli" | "script" | "service";
  description?: string;
  runtime?: ToolRuntime;
  protocols?: Array<{
    name: string;
    version?: string;
    transport: string;
    invocation: Invocation;
  }>;
  discovery: {
    strategy: string;
    primary?: string;
    help?: Invocation;
    manifest?: Invocation;
    a2c2a?: Invocation;
    commands?: Record<string, Invocation>;
    examples?: Record<string, Invocation>;
    base?: Invocation;
  };
  capabilities?: JsonValue;
}
