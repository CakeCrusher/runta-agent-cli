// Entry point: finds the command for argv, builds the request from flags, and applies the generic behaviors
// the spec asks for (lookups, defaults, validation, confirmation, waiting, streaming).
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { logActivity, readActivity, redactArgv } from "./activity.js";
import { flat, parseArgs, schemaAt, setNested } from "./args.js";
import { deviceName, forgetToken, resolveToken, saveToken } from "./auth.js";
import { Client } from "./client.js";
import { detectAgent, ensureDir, isInteractive, stateDir } from "./env.js";
import { CliError, EXIT, exitForStatus, usageError } from "./exit.js";
import { commandHelp, groupHelp, guide, topHelp } from "./help.js";
import { request, VERSION } from "./http.js";
import { note, printJson } from "./output.js";
import { fillDefaults, resolveNames } from "./resolve.js";
import { buildCommands, closest, deref, findGroup, loadSpec, OFFICIAL_VERBS, relatedCommands, suggestCommand } from "./spec.js";
import { readEvents } from "./sse.js";
import { checkForUpdate, INSTALL } from "./update.js";
import { coerce, validateBody, validateParam } from "./validate.js";
import { waitFor } from "./wait.js";
import { runSession } from "./ws.js";

const UTILITIES = ["guide", "schema", "api", "login", "logout", "doctor", "activity", "feedback", "help", "version"];
const MiB = 1024 * 1024;

export async function main(argv, env = process.env) {
  const started = Date.now();
  const spec = loadSpec(env);
  const groups = buildCommands(spec);
  const entry: Record<string, any> = { cli_version: VERSION, argv: redactArgv(argv), agent: detectAgent(env) };
  const update = checkForUpdate(env).catch(() => null);
  let code;
  try {
    code = await dispatch({ argv, env, spec, groups, entry });
  } catch (e) {
    const err = e instanceof CliError ? e : new CliError("internal", `unexpected error: ${e.stack || e.message}`, EXIT.apiError);
    (entry.errorsToStderr ? process.stderr : process.stdout).write(JSON.stringify(err.toJSON()) + "\n");
    entry.error = err.code;
    code = err.exitCode;
  }
  entry.exit_code = code;
  entry.duration_ms = Date.now() - started;
  if (entry.command || entry.utility) logActivity(entry, env);
  const u = await Promise.race([update, new Promise<null>((r) => setTimeout(r, 300, null))]);
  if (u?.outdated) note(`runta-agent-cli ${u.latest} is available (you have ${u.current}): ${INSTALL}`);
  return code;
}

async function dispatch({ argv, env, spec, groups, entry }) {
  const [first, second] = argv;
  if (!first || first === "--help" || first === "-h" || first === "help") {
    process.stdout.write(topHelp(spec, groups) + "\n");
    return EXIT.ok;
  }
  if (first === "--version" || first === "version") {
    process.stdout.write(`${VERSION}\n`);
    return EXIT.ok;
  }
  if (UTILITIES.includes(first)) {
    entry.utility = first;
    return utility(first, argv.slice(1), { env, spec, groups, entry });
  }
  const group = findGroup(groups, first);
  if (!group) {
    // Someone used to `runta exec` or `runta ps` gets pointed at the generated equivalent.
    const same = [...groups.values()].flatMap((g) => [...g.commands.values()].filter((c) => c.name === first));
    const hint = OFFICIAL_VERBS[first] ? `runta ${OFFICIAL_VERBS[first]}`
      : same.length ? same.map((c) => `runta ${c.group} ${c.name}`).join(" or ") : closest(first, [...groups.keys(), ...UTILITIES]);
    const related = hint ? [] : relatedCommands(spec, groups, first);
    throw usageError(`unknown command '${first}'${hint ? `; did you mean: ${hint}?` : related.length ? `; related: ${related.join(", ")}` : ""}`, { hint: "runta --help" });
  }
  if (!second || second === "--help" || second === "-h") {
    process.stdout.write(groupHelp(group, groups) + "\n");
    return EXIT.ok;
  }
  const cmd = group.commands.get(second);
  if (!cmd) {
    throw unknownCommand(spec, groups, group, second);
  }
  Object.assign(entry, { command: `${cmd.group} ${cmd.name}`, operation_id: cmd.operationId });
  const args = parseArgs(spec, cmd, argv.slice(2));
  const flag = (n) => args.values.get(n);
  if (flag("help")) {
    process.stdout.write(commandHelp(spec, cmd, groups) + "\n");
    return EXIT.ok;
  }
  const out = { fields: flag("fields")?.split(",").map((s) => s.trim()).filter(Boolean), truncate: flag("truncate"), pretty: flag("pretty") ?? Boolean(process.stdout.isTTY) };
  const client = makeClient({ spec, groups, env, flag, needAuth: !cmd.noAuth });

  // --- parameters ----------------------------------------------------------------------------------------
  const pathParams = cmd.params.filter((p) => p.in === "path");
  const values: Record<string, any> = {};
  const extra: string[] = [];
  args.positionals.forEach((v, i) => (i < pathParams.length ? (values[pathParams[i].name] = v) : extra.push(v)));
  for (const p of cmd.params) if (args.values.has(p.name)) values[p.name] = args.values.get(p.name);
  if (extra.length && !cmd.websocket) throw usageError(`unexpected argument${extra.length > 1 ? "s" : ""}: ${extra.join(" ")}`, { hint: `runta ${cmd.group} ${cmd.name} --help` });
  for (const p of cmd.params) {
    if (p.in === "header" && /^idempotency-key$/i.test(p.name) && values[p.name] === undefined) values[p.name] = randomUUID();
  }
  await resolveNames(client, cmd, values, (name, from, to) => note(`${name} "${from}" is ${to}`));
  await fillDefaults(client, cmd, values);
  const missing = cmd.params.filter((p) => p.required && values[p.name] === undefined);
  if (missing.length) {
    throw usageError(`missing ${missing.map((p) => (p.in === "path" ? `<${p.name}>` : `--${p.name.replace(/_/g, "-")}`)).join(", ")}`, { hint: `runta ${cmd.group} ${cmd.name} --help` });
  }
  const problems = cmd.params.filter((p) => values[p.name] !== undefined).flatMap((p) => validateParam(spec, p, values[p.name]));

  // --- body -------------------------------------------------------------------------------------------------
  let body;
  if (cmd.body) {
    body = readData(flag("data"), cmd.body.contentType);
    if (cmd.body.contentType === "application/json") {
      for (const [, entryDef] of args.table) {
        if (entryDef.kind === "body" && args.values.has(entryDef.name)) (body ||= {})[entryDef.name] = args.values.get(entryDef.name);
      }
      const full = deref(spec, cmd.body.schema || {});
      for (const [parts, raw] of args.nested) {
        // Like top-level flags: a plain value for a list field adds one item (repeat the flag for more); JSON sets it whole.
        const at = flat(schemaAt(full, parts));
        if (at.type === "array" && !/^\s*\[/.test(raw)) {
          const prev = parts.reduce((node, p) => (node && typeof node === "object" ? node[p] : undefined), body);
          setNested((body ||= {}), parts, [...(Array.isArray(prev) ? prev : []), coerce(raw, flat(at.items || {}))]);
        } else setNested((body ||= {}), parts, coerce(raw, at));
      }
      if (body === undefined && cmd.body.required) body = {};
      problems.push(...validateBody(spec, cmd.body.schema, body));
    }
  }
  if (problems.length) throw usageError("the request does not match the API schema; nothing was sent", { details: problems, hint: `runta ${cmd.group} ${cmd.name} --help` });
  if (cmd.body?.contentType === "application/json") await resolveNames(client, { params: [] }, {}, (name, from, to) => note(`${name} "${from}" is ${to}`), body);

  // --- streams over WebSocket (exec) -------------------------------------------------------------------------
  if (cmd.websocket) return execSession({ client, cmd, values, args, flag, env, entry, trailing: args.trailing || extra });

  const { path, query, headers } = client.place(cmd, values);
  const url = client.url(cmd, path, query);
  if (flag("dry-run")) {
    printJson({ dry_run: true, method: cmd.method, url, headers: Object.keys(headers), body: Buffer.isBuffer(body) ? `<${body.length} bytes>` : body ?? null }, out);
    return EXIT.ok;
  }
  if (cmd.destructive && !flag("yes")) await confirm(cmd, url, env);

  // --- send -------------------------------------------------------------------------------------------------------
  const res = await request({ method: cmd.method, url, token: cmd.noAuth ? undefined : client.token, headers, body, contentType: cmd.body?.contentType, stream: cmd.sse });
  Object.assign(entry, { method: cmd.method, path: cmd.path, status: res.status, request_id: res.requestId });
  if (res.status >= 400) {
    printJson(res.body ?? { error: { code: `http_${res.status}`, message: res.text?.slice(0, 2000) || "" } }, { pretty: out.pretty });
    return exitForStatus(res.status);
  }
  if (cmd.sse) {
    for await (const ev of readEvents(res.res!.body)) printJson(ev, out);
    return EXIT.ok;
  }
  if (res.buffer) {
    process.stdout.write(res.buffer);
    return EXIT.ok;
  }
  const waiting = flag("wait") && cmd.wait;
  if (!waiting) {
    if (res.body !== null && res.body !== undefined) printJson(res.body, out);
    else if (res.text) process.stdout.write(res.text + "\n");
    return EXIT.ok;
  }

  // --- wait ---------------------------------------------------------------------------------------------------------
  const ctx = { request: { path, query, body }, response: { body: res.body } };
  const result = await waitFor(client, cmd.wait, ctx, {
    timeoutSeconds: flag("timeout"),
    onState: (state, ms) => note(`waiting for ${cmd.wait.operationId}: ${state ?? "…"} (${Math.round(ms / 1000)}s)`),
  });
  entry.wait = { outcome: result.outcome, seconds: Math.round(result.waitedMs / 1000) };
  const deleted = (cmd.wait.until || []).some((c) => c.status === 404);
  printJson(deleted || !result.res.body ? res.body : result.res.body, out);
  if (result.outcome === "done") return EXIT.ok;
  if (result.outcome === "failed") {
    process.stderr.write(JSON.stringify({ error: { code: "failed_state", message: `${cmd.wait.operationId} reports a failed state; see the JSON on stdout` } }) + "\n");
    return EXIT.failedState;
  }
  process.stderr.write(JSON.stringify({ error: { code: "wait_timeout", message: `still not done after ${Math.round(result.waitedMs / 1000)}s; it may finish later (check with ${cmd.wait.operationId})` } }) + "\n");
  return EXIT.timeout;
}

function unknownCommand(spec, groups, group, name) {
  const hint = suggestCommand(group, name);
  const related = hint ? [] : relatedCommands(spec, groups, name, { only: group });
  const more = hint ? `; did you mean '${group.name} ${hint}'?`
    : related.length ? `; related: ${related.join(", ")}`
    : `; '${group.name}' has: ${[...group.commands.keys()].join(", ")}`;
  return usageError(`unknown command '${group.name} ${name}'${more}`, { hint: `runta ${group.name} --help` });
}

function makeClient({ spec, groups, env, flag, needAuth }) {
  const endpoint = flag("endpoint") || env.RUNTA_ENDPOINT || spec.servers?.[0]?.url || "https://api.runta.com";
  const cred = resolveToken(flag("token"), env);
  if (needAuth && !cred) {
    throw new CliError("unauthenticated", "no API key: set RUNTA_TOKEN, pass --token, or run `runta login`", EXIT.auth);
  }
  return new Client({ spec, groups, endpoint, token: cred?.token });
}

function readData(data, contentType) {
  if (data === undefined) return undefined;
  // `-` and `@-` read stdin (curl's convention); `@path` reads a file.
  const src = String(data);
  let raw;
  try {
    raw = src === "-" || src === "@-" ? readFileSync(0) : src.startsWith("@") ? readFileSync(src.slice(1)) : Buffer.from(src);
  } catch (e) {
    throw usageError(`cannot read --data ${src}: ${e.code || e.message}`);
  }
  if (contentType !== "application/json") return raw;
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch (e) {
    throw usageError(`--data is not valid JSON: ${e.message}`);
  }
}

async function confirm(cmd, url, env) {
  if (!isInteractive(env)) {
    throw new CliError("confirmation_required", `'${cmd.group} ${cmd.name}' (${cmd.summary}) is destructive and was not run; nothing changed. Re-run with --yes only if the user asked for this.`, EXIT.confirm, { would_send: `${cmd.method} ${url}` });
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(`${cmd.summary}: ${cmd.method} ${url}\nThis cannot be undone. Continue? [y/N] `);
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) throw new CliError("confirmation_required", "cancelled; nothing changed", EXIT.confirm);
}

async function execSession({ client, cmd, values, args, flag, env, entry, trailing }) {
  entry.errorsToStderr = true; // stdout belongs to the remote command
  if (!trailing?.length) throw usageError("give the command to run after --, e.g. runta runtimes exec my-runtime -- ls -la");
  const { path } = client.place(cmd, values);
  const url = client.url(cmd, path).replace(/^http/, "ws");
  const options = {};
  for (const [, def] of args.table) if (def.kind === "ws" && args.values.has(def.name)) options[def.name] = args.values.get(def.name);
  const maxOutput = flag("max-output") ?? (detectAgent(env) ? MiB : 0);
  const result = await runSession({
    url,
    token: client.token,
    session: cmd.websocket.session,
    argv: trailing,
    options,
    stdin: flag("stdin") ? process.stdin : null,
    timeoutSeconds: flag("timeout"),
    maxOutput,
  });
  Object.assign(entry, { method: "GET", path: cmd.path, ws: result.kind });
  if (result.kind === "exit") {
    entry.remote_exit = result.code;
    return result.code === -1 ? 143 : result.code;
  }
  const fail = (code, message, extra = {}) => {
    process.stderr.write(JSON.stringify({ error: { code, message, ...extra } }) + "\n");
    return 255;
  };
  if (result.kind === "timeout") {
    process.stderr.write(JSON.stringify({ error: { code: "exec_timeout", message: `stopped after ${flag("timeout")}s (SIGTERM sent)` } }) + "\n");
    return 124;
  }
  if (result.kind === "error") return fail("exec_error", result.message);
  if (result.kind === "incomplete") return fail("exec_incomplete", "the connection closed before the command reported an exit code; its outcome is unknown");
  entry.status = result.status;
  entry.request_id = result.requestId;
  const body = result.body && typeof result.body === "object" ? result.body : { error: { code: `http_${result.status}`, message: String(result.body || "connection failed") } };
  process.stderr.write(JSON.stringify(body) + "\n");
  return 255;
}

// --- utilities ---------------------------------------------------------------------------------------------------
async function utility(name, rest, { env, spec, groups, entry }) {
  const opts = parseLoose(rest);
  const flag = (n) => opts.flags[n];
  const out = { fields: flag("fields")?.split(","), truncate: flag("truncate") && Number(flag("truncate")), pretty: Boolean(flag("pretty") ?? process.stdout.isTTY) };
  if (flag("help") && name !== "help") {
    process.stdout.write(topHelp(spec, groups).split("Utilities:")[1].split("Global flags:")[0].trim() + "\n");
    return EXIT.ok;
  }
  switch (name) {
    case "help":
    case "version":
      return dispatch({ argv: [name === "help" ? "--help" : "--version"], env, spec, groups, entry });
    case "guide":
      process.stdout.write(guide(spec, groups) + "\n");
      return EXIT.ok;
    case "schema": {
      const [gName, cName] = opts.positionals;
      const g = findGroup(groups, gName || "");
      if (!g) {
        const hint = gName && closest(gName, [...groups.keys()]);
        throw usageError(`usage: runta schema <group> <command>${gName ? `; no group '${gName}'${hint ? `, did you mean '${hint}'?` : ""}` : ""}`, { hint: "runta --help" });
      }
      const cmd = g.commands.get(cName || "");
      if (!cmd) throw cName ? unknownCommand(spec, groups, g, cName) : usageError(`usage: runta schema ${g.name} <command>`, { hint: `runta ${g.name} --help` });
      const op = spec.paths[cmd.path][cmd.method.toLowerCase()];
      printJson(deref(spec, { operationId: cmd.operationId, method: cmd.method, path: cmd.path, summary: op.summary, description: op.description, parameters: cmd.params, requestBody: op.requestBody, responses: op.responses, "x-wait": op["x-wait"], destructive: cmd.destructive }), out);
      return EXIT.ok;
    }
    case "api": {
      const [method, path] = opts.positionals;
      if (!method || !path) throw usageError("usage: runta api <METHOD> <path> [--data JSON] [--query key=value ...]");
      const client = makeClient({ spec, groups, env, flag, needAuth: true });
      const query = Object.fromEntries((opts.multi.query || []).map((kv) => (kv as string).split(/=(.*)/s, 2)));
      const url = new URL(path.replace(/^\//, ""), client.endpoint.replace(/\/?$/, "/"));
      for (const [k, v] of Object.entries<string>(query)) url.searchParams.append(k, v);
      const body = flag("data") !== undefined ? readData(flag("data"), "application/json") : undefined;
      if (flag("dry-run")) {
        printJson({ dry_run: true, method: method.toUpperCase(), url: url.toString(), body: body ?? null }, out);
        return EXIT.ok;
      }
      const res = await request({ method: method.toUpperCase(), url: url.toString(), token: client.token, body });
      Object.assign(entry, { method: method.toUpperCase(), path, status: res.status, request_id: res.requestId });
      if (res.buffer) process.stdout.write(res.buffer);
      else if (res.body !== null) printJson(res.body, out);
      else if (res.text) process.stdout.write(res.text + "\n");
      return exitForStatus(res.status);
    }
    case "login":
      return login(opts, { env, spec, groups, out });
    case "logout": {
      const cred = resolveToken(undefined, env);
      if (flag("revoke") && cred) {
        const client = makeClient({ spec, groups, env, flag, needAuth: true });
        const res = await client.call("revokeCurrentToken");
        if (res.status >= 400) {
          printJson(res.body, out);
          return exitForStatus(res.status);
        }
      }
      forgetToken(env);
      printJson({ logged_out: true, revoked: Boolean(flag("revoke")), note: env.RUNTA_TOKEN ? "RUNTA_TOKEN is still set in this environment" : undefined }, out);
      return EXIT.ok;
    }
    case "doctor":
      return doctor({ env, spec, groups, flag, out });
    case "activity":
      for (const e of readActivity(Number(flag("limit") || 20), env)) printJson(e, { ...out, pretty: false });
      return EXIT.ok;
    case "feedback": {
      const message = opts.positionals.join(" ").trim();
      if (!message) throw usageError('usage: runta feedback "what went wrong or what you expected"');
      const dir = ensureDir(join(stateDir(env), "feedback"));
      const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
      const bundle = { message, cli_version: VERSION, node: process.versions.node, platform: process.platform, agent: detectAgent(env), spec: spec["x-loaded-from"], recent_activity: readActivity(Number(flag("limit") || 20), env) };
      writeFileSync(file, JSON.stringify(bundle, null, 2) + "\n", { mode: 0o600 });
      printJson({ saved: file, entries: bundle.recent_activity.length, note: "Runta has no public feedback endpoint yet: share this file (it contains no credentials or request bodies)." }, out);
      return EXIT.ok;
    }
  }
  return EXIT.usage;
}

// Utilities take simple flags: --name value, --name=value, bare --flag, repeated flags collected in multi.
function parseLoose(argv: string[]) {
  const flags: Record<string, any> = {};
  const multi: Record<string, (string | true)[]> = {};
  const positionals: string[] = [];
  const BOOL = new Set(["help", "no-wait", "resume", "with-token", "revoke", "pretty", "dry-run", "json"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") flags.help = true;
    else if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split(/=(.*)/s, 2);
      const value = v !== undefined ? v : BOOL.has(k) ? true : argv[++i];
      flags[k] = value;
      (multi[k] ||= []).push(value);
    } else positionals.push(a);
  }
  return { flags, multi, positionals };
}

async function login(opts, { env, spec, groups, out }) {
  const flag = (n) => opts.flags[n];
  const endpoint = flag("endpoint") || env.RUNTA_ENDPOINT || spec.servers?.[0]?.url || "https://api.runta.com";
  const client = new Client({ spec, groups, endpoint, token: null });
  const verify = async (token) => {
    const res = await new Client({ spec, groups, endpoint, token }).call("getMe");
    if (res.status >= 400) throw new CliError(res.body?.error?.code || "unauthenticated", `the key was rejected: ${res.body?.error?.message || res.status}`, exitForStatus(res.status));
    return res.body?.data || res.body;
  };
  if (flag("with-token")) {
    const token = readFileSync(0, "utf8").trim();
    if (!token) throw usageError("pipe the API key on stdin: printf %s \"$KEY\" | runta login --with-token");
    const user = await verify(token);
    printJson({ logged_in: true, stored_in: saveToken(token, env), user: user?.email }, out);
    return EXIT.ok;
  }
  const pendingFile = join(stateDir(env), "login-pending.json");
  let pending: any;
  if (flag("resume")) {
    try {
      pending = JSON.parse(readFileSync(pendingFile, "utf8"));
    } catch {
      throw usageError("no login in progress; start one with `runta login --no-wait`");
    }
  } else {
    const res = await client.call("beginDeviceAuthorization", {}, { body: { client_id: "runta_cli", device_name: deviceName() } });
    if (res.status >= 400) {
      printJson(res.body, out);
      return exitForStatus(res.status);
    }
    pending = res.body?.data || res.body;
    ensureDir(stateDir(env));
    writeFileSync(pendingFile, JSON.stringify(pending) + "\n", { mode: 0o600 });
    const show = { action_required: "open the URL and approve the code, then this login completes", url: pending.verification_uri_complete, code: pending.user_code, expires_at: pending.expires_at };
    if (flag("no-wait")) {
      printJson({ ...show, action_required: "ask the user to open the URL and approve the code, then run `runta login --resume`" }, out);
      return EXIT.ok;
    }
    process.stderr.write(`Open ${pending.verification_uri_complete} and approve code ${pending.user_code}\n`);
  }
  let interval = (pending.interval || 5) * 1000;
  const deadline = Date.parse(pending.expires_at || "") || Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const res = await client.call("exchangeDeviceToken", {}, { body: { device_code: pending.device_code } });
    if (res.status === 200 && res.body?.access_token) {
      const stored = saveToken(res.body.access_token, env);
      writeFileSync(pendingFile, "{}\n");
      const user = await verify(res.body.access_token).catch(() => null);
      printJson({ logged_in: true, stored_in: stored, user: user?.email }, out);
      return EXIT.ok;
    }
    const code = res.body?.error;
    if (code === "slow_down") interval += 5000;
    else if (code && code !== "authorization_pending") {
      printJson({ error: { code: typeof code === "string" ? code : code.code, message: "login was not approved" } }, out);
      return EXIT.auth;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  printJson({ error: { code: "expired_token", message: "the code expired before it was approved; run `runta login` again" } }, out);
  return EXIT.auth;
}

async function doctor({ env, spec, groups, flag, out }) {
  const endpoint = flag("endpoint") || env.RUNTA_ENDPOINT || spec.servers?.[0]?.url || "https://api.runta.com";
  const cred = resolveToken(flag("token"), env);
  const report: Record<string, any> = { cli_version: VERSION, node: process.versions.node, endpoint, spec: spec["x-loaded-from"], agent: detectAgent(env), credential: cred ? { source: cred.source } : null };
  const client = new Client({ spec, groups, endpoint, token: cred?.token });
  const health = await request({ method: "GET", url: client.url(client.command("healthz")) }).catch((e) => ({ status: 0, error: e.message }));
  report.api = { reachable: health.status === 200, status: health.status };
  if (cred) {
    const me = await client.call("getMe").catch((e) => ({ status: 0, body: { error: { message: e.message } } }));
    report.credential.valid = me.status === 200;
    report.credential.user = me.body?.data?.email;
    if (me.status !== 200) report.credential.error = me.body?.error;
  }
  report.update = await checkForUpdate(env, { force: true }).catch(() => null);
  printJson(report, out);
  if (!report.api.reachable) return EXIT.unavailable;
  return report.credential?.valid ? EXIT.ok : EXIT.auth;
}

