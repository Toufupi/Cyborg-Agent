# Cyborg Tool Standard

Status: draft v0.1  
Reference implementation: Page-Generator-CLI

The Cyborg Tool Standard defines how a CLI or script becomes a managed Cyborg-Agent tool. It complements A2C2A.

- A2C2A defines request, response, result, and repairable errors.
- Cyborg Tool Standard defines discovery, registration, runtime, and execution constraints.

## Goals

Tools should be:

- easy to register;
- self-describing through help and manifest;
- callable through A2C2A;
- runnable only inside a Cyborg-managed environment when they perform real work;
- language-neutral at the standard level, but Node-first in the first implementation.

## Required CLI Shape

A managed CLI should support:

```powershell
tool --help
tool <command> --help
tool manifest
tool a2c2a
```

Recommended registration command:

```powershell
tool install-cyborg <agentRoot>
```

If a tool does not implement self-install, it can provide a registration JSON file and Cyborg-Agent can add it:

```powershell
cyborg tool add tool-registration.json
```

## Registration File

Tool registrations live in:

```text
.cyborg/tools/*.json
```

Minimum shape:

```json
{
  "schema": "a2c2a.tool-registration.v0.1",
  "name": "page-generator-cli",
  "version": "0.1.0",
  "type": "cli",
  "description": "Generate themed static HTML pages from validated component JSON.",
  "runtime": {
    "type": "node",
    "requires_cyborg_shell": true,
    "required_env": [
      "CYBORG_SHELL",
      "CYBORG_WORKSPACE_ROOT",
      "CYBORG_TOOL_REGISTRY"
    ]
  },
  "discovery": {
    "strategy": "self_describing_cli",
    "help": { "command": "pagegen", "args": ["--help"] },
    "manifest": { "command": "pagegen", "args": ["manifest"] },
    "a2c2a": { "command": "pagegen", "args": ["a2c2a"] }
  }
}
```

## Runtime Model

The standard should stay language-neutral. The first Cyborg-Agent implementation should support Node tools first.

Runtime types:

```text
node      supported in v0.1
python    planned extension
native    planned extension
service   planned extension
```

Runtime declaration:

```json
{
  "runtime": {
    "type": "node",
    "node": ">=20",
    "cwd": "C:/path/to/tool-repo",
    "package_manager": "npm",
    "install_strategy": "external_repo",
    "isolated": true,
    "requires_cyborg_shell": true,
    "required_env": ["CYBORG_SHELL", "CYBORG_WORKSPACE_ROOT"]
  }
}
```

Isolation fields:

- `cwd`: absolute or workspace-relative runtime root for the tool's own package and dependencies.
- `package_manager`: `npm`, `pnpm`, or `yarn`.
- `install_strategy`: `external_repo` for a separately cloned repo, `tool_env` for a future Cyborg-managed tool environment, or `none`.
- `isolated`: when true, Cyborg requires `cwd` and prepends `<cwd>/node_modules/.bin` for Node tools.

Diagnostics:

```powershell
cyborg tool doctor page-generator-cli
cyborg tool env page-generator-cli
cyborg tool install page-generator-cli
```

`tool env` is intentionally machine-readable JSON so a small model can inspect the runtime without spending tokens on terminal-specific output.

Python can be added later without changing the registry shape:

```json
{
  "runtime": {
    "type": "python",
    "python": ">=3.11",
    "requires_cyborg_shell": true,
    "required_env": ["CYBORG_SHELL", "CYBORG_WORKSPACE_ROOT"]
  }
}
```

If a tool declares an unsupported runtime, Cyborg-Agent should return a structured error instead of guessing how to run it.

Recommended issue code:

```json
{
  "code": "runtime_not_supported",
  "expected": ["node"],
  "actual": "python"
}
```

## Cyborg Shell Requirement

Real work should run inside a Cyborg-managed environment. Discovery commands can remain open.

Allowed outside Cyborg shell:

- `tool --help`
- `tool <command> --help`
- `tool manifest`
- `tool install-cyborg`

Should require Cyborg shell:

- rendering;
- exporting;
- writing files;
- network or browser automation;
- A2C2A calls that execute tool actions.

Cyborg shell should set:

```text
CYBORG_SHELL=1
CYBORG_WORKSPACE_ROOT=<absolute workspace path>
CYBORG_TOOL_REGISTRY=<absolute .cyborg/tools path>
CYBORG_SESSION_ID=<session id>
```

If a tool is called outside the required environment, it should return a structured error:

```json
{
  "ok": false,
  "error": {
    "type": "custom_error",
    "message": "Tool requires Cyborg-Agent runtime environment.",
    "details": {
      "namespace": "cyborg.runtime",
      "issues": [
        {
          "path": "$.env.CYBORG_SHELL",
          "code": "cyborg_shell_required",
          "message": "This tool can only run inside a Cyborg-Agent shell.",
          "expected": "1",
          "actual": null
        }
      ]
    }
  }
}
```

Environment variables are not a complete security boundary. They are a protocol gate. Stronger safety should also include workspace limits, permission policy, and audit logs.

## Discovery Flow

Cyborg-Agent should use tools through one gateway:

```powershell
cyborg tool list
cyborg tool info <name>
cyborg tool help <name>
cyborg tool help <name> <command>
cyborg tool manifest <name>
cyborg tool call <name> --request request.json
```

Agent loop:

```text
scan .cyborg/tools
  -> run help for usage
  -> run manifest for contracts
  -> build A2C2A request
  -> call tool through Cyborg runner
  -> repair from structured errors
```

## First Implementation Scope

For v0.1:

- implement Node runtime only;
- recognize but do not execute Python runtime;
- require registration files for managed tools;
- keep help and manifest as first-class discovery commands;
- route A2C2A calls through `cyborg tool call`.

Python backend should be added later as a runtime extension, not as a protocol redesign.
