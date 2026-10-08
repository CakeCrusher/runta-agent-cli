// Credentials: where the API key comes from, and where `runta login` keeps it.
// Order: --token, RUNTA_TOKEN, the OS keychain (or a 0600 file where there is none), the official CLI's config.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { APP, configDir, ensureDir } from "./env.js";

const ACCOUNT = "default";

function store(env) {
  if (env.RUNTA_CREDENTIAL_STORE === "file") return "file";
  if (process.platform === "darwin") return "keychain";
  if (process.platform === "linux" && spawnSync("sh", ["-c", "command -v secret-tool"]).status === 0) return "secret-tool";
  return "file";
}

const credFile = (env) => join(configDir(env), "credentials.json");

export function readStoredToken(env = process.env) {
  const kind = store(env);
  if (kind === "keychain") {
    const r = spawnSync("security", ["find-generic-password", "-s", APP, "-a", ACCOUNT, "-w"], { encoding: "utf8" });
    return r.status === 0 && r.stdout.trim() ? { token: r.stdout.trim(), source: "keychain" } : null;
  }
  if (kind === "secret-tool") {
    const r = spawnSync("secret-tool", ["lookup", "service", APP, "account", ACCOUNT], { encoding: "utf8" });
    return r.status === 0 && r.stdout.trim() ? { token: r.stdout.trim(), source: "secret-tool" } : null;
  }
  try {
    const { token } = JSON.parse(readFileSync(credFile(env), "utf8"));
    return token ? { token, source: credFile(env) } : null;
  } catch {
    return null;
  }
}

export function saveToken(token, env = process.env) {
  const kind = store(env);
  if (kind === "keychain") {
    const r = spawnSync("security", ["add-generic-password", "-U", "-s", APP, "-a", ACCOUNT, "-w", token]);
    if (r.status === 0) return "keychain";
  } else if (kind === "secret-tool") {
    const r = spawnSync("secret-tool", ["store", "--label", APP, "service", APP, "account", ACCOUNT], { input: token });
    if (r.status === 0) return "secret-tool";
  }
  ensureDir(configDir(env));
  writeFileSync(credFile(env), JSON.stringify({ token, saved_at: new Date().toISOString() }) + "\n", { mode: 0o600 });
  return credFile(env);
}

export function forgetToken(env = process.env) {
  const kind = store(env);
  if (kind === "keychain") spawnSync("security", ["delete-generic-password", "-s", APP, "-a", ACCOUNT]);
  if (kind === "secret-tool") spawnSync("secret-tool", ["clear", "service", APP, "account", ACCOUNT]);
  if (existsSync(credFile(env))) rmSync(credFile(env));
}

// The official CLI keeps `token = "..."` in ~/.config/runta/config.toml; reusing it saves a second login.
function officialConfigToken(env) {
  const file = env.RUNTA_CONFIG || join(homedir(), ".config", "runta", "config.toml");
  try {
    const m = readFileSync(file, "utf8").match(/^token\s*=\s*"([^"]+)"/m);
    return m ? { token: m[1], source: file } : null;
  } catch {
    return null;
  }
}

export function resolveToken(flagToken, env = process.env) {
  if (flagToken) return { token: flagToken, source: "--token" };
  if (env.RUNTA_TOKEN) return { token: env.RUNTA_TOKEN, source: "RUNTA_TOKEN" };
  return readStoredToken(env) || officialConfigToken(env) || null;
}

export const deviceName = () => `runta-agent-cli on ${hostname()}`;
