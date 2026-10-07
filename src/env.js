// Where the CLI keeps state, and who is calling it.
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export const APP = "runta-agent-cli";

export function configDir(env = process.env) {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), APP);
}

export function stateDir(env = process.env) {
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), APP);
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// Coding agents announce themselves through environment variables; the first match wins.
const AGENT_VARS = [
  ["AI_AGENT", (v) => v],
  ["CLAUDECODE", () => "claude-code"],
  ["CLAUDE_CODE_ENTRYPOINT", () => "claude-code"],
  ["CODEX_SANDBOX", () => "codex"],
  ["CODEX_THREAD_ID", () => "codex"],
  ["CURSOR_AGENT", () => "cursor"],
  ["CURSOR_TRACE_ID", () => "cursor"],
  ["GEMINI_CLI", () => "gemini-cli"],
  ["OPENCODE", () => "opencode"],
  ["GOOSE_TERMINAL", () => "goose"],
  ["AMP_CLI", () => "amp"],
];

export function detectAgent(env = process.env) {
  for (const [name, label] of AGENT_VARS) if (env[name]) return label(env[name]);
  return null;
}

// Interactive only when a person can answer: a terminal on both ends and no agent detected.
export function isInteractive(env = process.env) {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && !detectAgent(env) && !env.CI;
}
