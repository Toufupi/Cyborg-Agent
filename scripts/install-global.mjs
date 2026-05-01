#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cyborgCommand = process.platform === "win32" ? "cyborg.cmd" : "cyborg";
const npmExecPath = process.env.npm_execpath;

function run(command, args, options = {}) {
  console.log(`\n> ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    ...options
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function assertCommand(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "ignore", shell: false });
  if (result.error || result.status !== 0) {
    console.error(`Missing required command: ${command}`);
    process.exit(1);
  }
}

function runNpm(args) {
  if (npmExecPath) {
    run(process.execPath, [npmExecPath, ...args]);
    return;
  }
  run(process.platform === "win32" ? "npm.cmd" : "npm", args, { shell: process.platform === "win32" });
}

function assertNpm() {
  if (npmExecPath) {
    assertCommand(process.execPath, [npmExecPath, "--version"]);
    return;
  }
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"], {
    cwd: root,
    stdio: "ignore",
    shell: process.platform === "win32"
  });
  if (result.error || result.status !== 0) {
    console.error("Missing required command: npm");
    process.exit(1);
  }
}

function npmPrefixGlobal() {
  const args = ["prefix", "-g"];
  const result = npmExecPath
    ? spawnSync(process.execPath, [npmExecPath, ...args], { cwd: root, encoding: "utf8", shell: false })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
      cwd: root,
      encoding: "utf8",
      shell: process.platform === "win32"
    });
  if (result.error || result.status !== 0) {
    return undefined;
  }
  return result.stdout.trim();
}

function resolveLinkedCyborgCommand() {
  const prefix = npmPrefixGlobal();
  if (!prefix) {
    return cyborgCommand;
  }
  return process.platform === "win32"
    ? resolve(prefix, "cyborg.cmd")
    : resolve(prefix, "bin", "cyborg");
}

function runCyborgSmoke() {
  const command = resolveLinkedCyborgCommand();
  if (process.platform === "win32") {
    run("cmd.exe", ["/d", "/c", "call", command, "--help"], { cwd: process.cwd() });
    return;
  }
  run(command, ["--help"], { cwd: process.cwd() });
}

console.log("Cyborg-Agent global installer");
console.log(`Root: ${root}`);

assertCommand(process.execPath, ["--version"]);
assertNpm();

runNpm([existsSync(resolve(root, "package-lock.json")) ? "ci" : "install"]);
runNpm(["run", "build"]);
runNpm(["link"]);
runCyborgSmoke();

console.log("\nInstalled. You can now run:");
console.log("  cyborg --help");
console.log("  cyborg chat");
