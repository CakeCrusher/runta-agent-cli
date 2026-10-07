// Local activity log: one JSON line per invocation, so a person (or the agent) can reconstruct what happened
// and quote request IDs to Runta. Request bodies are never logged; they can carry secret values.
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, stateDir } from "./env.js";

const MAX_BYTES = 5 * 1024 * 1024;

export const activityFile = (env = process.env) => join(stateDir(env), "activity.jsonl");

export function logActivity(entry, env = process.env) {
  if (env.RUNTA_ACTIVITY_LOG === "0") return;
  try {
    const file = activityFile(env);
    ensureDir(stateDir(env));
    if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, file + ".1");
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
  } catch {
    // Logging must never break a command.
  }
}

export function readActivity(limit = 20, env = process.env) {
  const file = activityFile(env);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-limit).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { unparsed: l };
    }
  });
}

// Never write credentials to the log: values of flags that can carry them are replaced, and so is
// everything after `--` (an exec command line can contain anything).
const SENSITIVE = /token|secret|password|value|key|data|env|prompt/i;

export function redactArgv(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out.push("--", `<${argv.length - i - 1} args redacted>`);
      break;
    }
    const m = a.match(/^--([^=]+)(=.*)?$/);
    if (m && SENSITIVE.test(m[1])) {
      if (m[2] !== undefined) out.push(`--${m[1]}=<redacted>`);
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) {
        out.push(a, "<redacted>");
        i++;
      } else out.push(a);
    } else out.push(a);
  }
  return out;
}
