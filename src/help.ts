// Help text is rendered from the spec. Operation IDs written in backticks become the matching command,
// so a description written once for the API reads naturally in the CLI.
import { bodyFields, flat, GLOBAL_FLAGS } from "./args.js";
import { commandByOperationId, deref, kebab } from "./spec.js";
import { EXIT } from "./exit.js";

export function renderText(text, groups) {
  // Backticked or bare camelCase operation IDs (getRuntime, `createCloudAgent`) become commands.
  return (text || "").replace(/`?\b([a-z]+[A-Z][A-Za-z0-9]*)\b`?/g, (m, id) => {
    const cmd = commandByOperationId(groups, id);
    return cmd ? `\`runta ${cmd.group} ${cmd.name}\`` : m;
  });
}

// Joins hard-wrapped lines back into paragraphs and list items, drops markdown emphasis, then wraps.
const reflow = (text) =>
  text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .split(/\n\s*\n/)
    .map((block) =>
      block
        .split("\n")
        .reduce((acc, line) => {
          if (/^\s*- /.test(line) || !acc.length) acc.push(line.trimEnd());
          else acc[acc.length - 1] += " " + line.trim();
          return acc;
        }, [])
        .join("\n"),
    )
    .join("\n\n");

const wrap = (text, indent = 0, width = 100) => {
  const pad = " ".repeat(indent);
  return reflow(text)
    .split("\n")
    .map((line) => {
      if (!line.trim()) return "";
      const lead = line.match(/^\s*(- )?/)[0];
      const out: string[] = [];
      let cur = "";
      for (const w of line.trim().split(/\s+/)) {
        if ((cur + " " + w).trim().length + indent + lead.length > width && cur) {
          out.push(cur);
          cur = w;
        } else cur = (cur + " " + w).trim();
      }
      out.push(cur);
      return out.map((l, i) => pad + (i === 0 ? "" : " ".repeat(lead.length)) + l).join("\n");
    })
    .join("\n");
};

export function typeLabel(schema) {
  const s = flat(schema);
  if (s.enum) return s.enum.length <= 9 ? s.enum.join("|") : `${s.type || "string"} (${s.enum.length} values)`;
  if (s.type === "array") return `${typeLabel(s.items || {})}[]`;
  if (s.oneOf || s.anyOf) return "object (one of)";
  return s.type || "object";
}

const oneLine = (t = "") => reflow(t).replace(/\s+/g, " ").trim();

// A flag (or argument) row: the full description wrapped under a fixed column, never cut short.
function rows(flag, desc, col = 36, width = 112) {
  const chunks: string[] = [];
  let cur = "";
  for (const w of (desc || "").split(/\s+/).filter(Boolean)) {
    if (cur && cur.length + 1 + w.length > width - col) {
      chunks.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) chunks.push(cur);
  const head = `  ${flag}`;
  const pad = " ".repeat(col);
  if (!chunks.length) return [head];
  if (head.length + 2 > col) return [head, ...chunks.map((c) => pad + c)];
  return [head.padEnd(col) + chunks[0], ...chunks.slice(1).map((c) => pad + c)];
}

const objectish = (s) => !!(s && (s.properties || s.oneOf || s.anyOf));

// Fields inside a body field, so an agent never has to open the spec. Fields of an object are set with a dot and
// their exact JSON name (--image.model_provider_protocol); the fields of a list's items are given as JSON.
function nestedRows(schema, path, depth, groups, out, asFlag) {
  const s = flat(schema);
  if (!s || depth > 5) return;
  const variants = [...(s.oneOf || []), ...(s.anyOf || [])].map(flat).filter((v) => v.properties);
  if (variants.length) {
    for (const v of variants) {
      const tag = Object.entries(v.properties).map(([k, p]) => [k, flat(p)]).find(([, p]) => p.enum?.length === 1 || p.const !== undefined);
      const label = tag ? `${tag[0]} = ${tag[1].const ?? tag[1].enum[0]}` : v.title || "variant";
      out.push([`${"  ".repeat(depth)}when ${label}:`, oneLine(renderText(v.description || "", groups))]);
      fieldRows(v, path, depth + 1, groups, out, asFlag);
    }
    return;
  }
  fieldRows(s, path, depth, groups, out, asFlag);
}

function fieldRows(s, path, depth, groups, out, asFlag) {
  const req = new Set(s.required || []);
  for (const [k, raw] of Object.entries(s.properties || {})) {
    const fs = flat(raw);
    const desc = fs.description || (fs.type === "array" ? flat(fs.items).description : "") || "";
    out.push([`${"  ".repeat(depth)}${asFlag ? "--" : ""}${path}.${k} ${typeLabel(fs)}`, `${req.has(k) ? "(required) " : ""}${oneLine(renderText(desc, groups))}`]);
    if (fs.type === "array" && objectish(flat(fs.items))) nestedRows(fs.items, `${path}.${k}[]`, depth + 1, groups, out, false);
    else if (objectish(fs)) nestedRows(fs, `${path}.${k}`, depth + 1, groups, out, asFlag);
  }
}

function utilities() {
  return [
    ["guide", "What Runta is for, the main workflows, output and exit-code conventions"],
    ["schema <group> <command>", "Parameters, body and response schema of a command, as JSON"],
    ["api <METHOD> <path>", "Call any endpoint directly, e.g. runta api GET /v2/me"],
    ["login", "Sign in with a device code (--no-wait/--resume for agents) or store a key (--with-token)"],
    ["logout", "Forget the stored credential (--revoke also revokes it server-side)"],
    ["doctor", "Check credential, API reachability and CLI version"],
    ["activity", "Show this CLI's local activity log (--limit N)"],
    ["feedback <message>", "Save a feedback bundle with recent activity to send to Runta"],
  ];
}

export function topHelp(spec, groups) {
  const lines: string[] = [];
  lines.push(`runta: CLI for the ${spec.info?.title || "Runta API"}, generated from its OpenAPI spec`, "");
  lines.push(wrap(renderText(spec.info?.description || "", groups), 2), "");
  lines.push("Usage: runta <group> <command> [args] [--flags]      (runta <group> --help lists commands)", "");
  lines.push("Groups:");
  for (const g of groups.values()) {
    const alias = g.aliases.length ? ` (alias: ${g.aliases.join(", ")})` : "";
    lines.push(`  ${g.name.padEnd(26)}${g.commands.size} command${g.commands.size === 1 ? "" : "s"}${alias}`);
  }
  lines.push("", "Utilities:");
  for (const [n, d] of utilities()) lines.push(`  ${n.padEnd(26)}${d}`);
  lines.push("", "Global flags:");
  for (const [n, f] of Object.entries(GLOBAL_FLAGS)) lines.push(`  --${n.padEnd(24)}${f.help}`);
  lines.push("", "Output is the API's JSON on stdout; progress and notices go to stderr. Exit codes: see `runta guide`.");
  return lines.join("\n");
}

export function groupHelp(group, groups) {
  const lines = [`runta ${group.name}: ${group.tag}${group.aliases.length ? ` (alias: ${group.aliases.join(", ")})` : ""}`, ""];
  if (group.description) lines.push(wrap(renderText(group.description, groups), 2), "");
  lines.push("Commands:");
  for (const c of group.commands.values()) {
    const marks = [c.destructive && "destructive", c.wait && "--wait", c.sse && "stream", c.websocket && "websocket"].filter(Boolean);
    lines.push(`  ${c.name.padEnd(30)}${c.summary}${marks.length ? `  [${marks.join(", ")}]` : ""}`);
  }
  lines.push("", `Help for one command: runta ${group.name} <command> --help`);
  return lines.join("\n");
}

// Enum values with documented meanings anywhere in a response (e.g. a runtime's status).
function responseMeanings(spec, cmd) {
  const ok = Object.entries<any>(spec.paths[cmd.path][cmd.method.toLowerCase()].responses || {}).find(([c]) => /^2/.test(c));
  const schema = ok?.[1]?.content?.["application/json"]?.schema;
  if (!schema) return [];
  const found: [string, Record<string, string>][] = [];
  const walk = (s, path, depth) => {
    s = flat(s);
    if (!s || depth > 4) return;
    if (s.enum && s["x-enum-descriptions"]) found.push([path, s["x-enum-descriptions"]]);
    for (const [k, v] of Object.entries(s.properties || {})) walk(v, path ? `${path}.${k}` : k, depth + 1);
  };
  walk(deref(spec, schema), "", 0);
  return found;
}

export function commandHelp(spec, cmd, groups) {
  const pathParams = cmd.params.filter((p) => p.in === "path");
  const positional = pathParams.map((p) => `<${p.name}>`).join(" ");
  const tail = cmd.websocket ? " -- <command> [args...]" : "";
  const lines = [`runta ${cmd.group} ${cmd.name}${positional ? " " + positional : ""}${tail} [--flags]`, ""];
  lines.push(`  ${cmd.summary}  (${cmd.method} ${cmd.path}, operation ${cmd.operationId})`);
  if (cmd.description) lines.push("", wrap(renderText(cmd.description, groups), 2));
  if (pathParams.length) {
    lines.push("", "Arguments:");
    const lookups = spec["x-name-lookups"] || {};
    for (const p of pathParams) {
      const lk = lookups[p.name];
      const byName = lk ? ` A ${lk.match.join("/")} also works (looked up with ${renderText("`" + lk.operationId + "`", groups)}).` : "";
      lines.push(...rows(`<${p.name}>`, `${oneLine(renderText(p.description || p.schema?.description || "", groups))}${byName}`, 30));
    }
  }
  const flags: [string, string][] = [];
  for (const p of cmd.params.filter((x) => x.in !== "path")) {
    const auto = p["x-default-from"] ? " Filled in automatically when omitted." : "";
    flags.push([`--${kebab(p.name)} ${typeLabel(p.schema || {})}`, `${p.required && !p["x-default-from"] ? "(required) " : ""}${oneLine(renderText(p.description || "", groups))}${auto}`]);
  }
  let naming: string | null = null;
  if (cmd.body?.contentType === "application/json") {
    const { props, required } = bodyFields(spec, cmd.body.schema);
    for (const [n, s] of Object.entries(props)) {
      const fs = flat(s);
      const desc = fs.description || (fs.type === "array" ? flat(fs.items).description : "") || "";
      flags.push([`--${kebab(n)} ${typeLabel(fs)}`, `${required.has(n) ? "(required) " : ""}${oneLine(renderText(desc, groups))}`]);
      if (fs["x-enum-descriptions"]) for (const [v, d] of Object.entries<string>(fs["x-enum-descriptions"])) flags.push([`    ${v}`, renderText(d, groups)]);
      const inner = [];
      if (fs.type === "array" && objectish(flat(fs.items))) nestedRows(fs.items, `${n}[]`, 2, groups, inner, false);
      else if (objectish(fs)) nestedRows(fs, kebab(n), 2, groups, inner, true);
      flags.push(...inner);
      const leaf = !naming && fs.properties && Object.entries(fs.properties).find(([, v]) => !objectish(flat(v)) && flat(v).type !== "array");
      if (leaf) naming = `--${kebab(n)}.${leaf[0]}`;
    }
    flags.push(["--data <json|@file|->", "Whole body as JSON; flags override its fields"]);
  } else if (cmd.body) {
    flags.push(["--data <@file|->", `Request body (${cmd.body.contentType})`]);
  }
  if (cmd.websocket) {
    flags.push(["--env KEY=VALUE", "Environment variable for the command (repeatable)"]);
    flags.push(["--stdin", "Forward this process's stdin to the command (default: no input)"]);
    flags.push(["--timeout <seconds>", "Stop the command after this long (exit 124)"]);
    flags.push(["--max-output <bytes>", "Stop printing output after this many bytes (default 1 MiB for agents, 0 = no limit)"]);
  }
  if (cmd.wait) {
    const until = cmd.wait.until?.map((c) => (c.status ? `HTTP ${c.status}` : `${c.pointer.split("/").pop()} = ${c.in.join("|")}`)).join(" or ");
    flags.push(["--wait", `Return only when done: polls ${renderText(cmd.wait.operationId, groups)} until ${until}`]);
    flags.push(["--timeout <seconds>", `Give up waiting after this long (default ${cmd.wait.timeoutSeconds || 300}; exit ${EXIT.timeout})`]);
  }
  if (cmd.destructive) flags.push(["--yes, -y", "Confirm. Without a terminal this command refuses to run unless --yes is given"]);
  if (cmd.method !== "GET") flags.push(["--dry-run", "Print the request instead of sending it"]);
  if (flags.length) {
    lines.push("", "Flags:");
    if (cmd.body?.contentType === "application/json")
      lines.push(...wrap(`Body fields are --kebab-case flags. A field inside one is set with a dot and its exact JSON name${naming ? ` (${naming} <value>)` : ""}; a list of objects is given as JSON, or in --data.`, 2, 112).split("\n"));
    for (const [f, d] of flags) lines.push(...rows(f, d));
  }
  const meanings = responseMeanings(spec, cmd);
  for (const [path, values] of meanings) {
    lines.push("", `Values of ${path} in the response:`);
    for (const [v, d] of Object.entries(values)) lines.push(`  ${v.padEnd(14)}${renderText(d, groups)}`);
  }
  lines.push("", `Full schema: runta schema ${cmd.group} ${cmd.name}`);
  return lines.join("\n");
}

function errorMeanings(spec) {
  for (const item of Object.values<any>(spec.paths || {}))
    for (const op of Object.values<any>(item)) {
      const s = op?.responses?.default?.content?.["application/json"]?.schema || (op?.responses?.default?.$ref && deref(spec, op.responses.default).content?.["application/json"]?.schema);
      const code = s && flat(deref(spec, s)).properties?.error && flat(flat(deref(spec, s)).properties.error).properties?.code;
      if (code && flat(code)["x-enum-descriptions"]) return flat(code)["x-enum-descriptions"];
    }
  return null;
}

export function guide(spec, groups) {
  const lines = [wrap(renderText(spec.info?.description || "", groups), 0), ""];
  lines.push("Conventions of this CLI:");
  lines.push("- Commands are generated from the API spec: runta <group> <command>, path parameters positional,");
  lines.push("  query parameters and body fields as --flags (nested: --a.b), or the whole body with --data.");
  lines.push("- stdout is exactly the API's JSON response (narrow it with --fields); progress goes to stderr.");
  lines.push("- Errors use the API's shape: {\"error\": {\"code\", \"message\"}, \"request_id\"}, also for errors the CLI");
  lines.push("  raises itself (bad flags, refused confirmation), so there is one format to parse.");
  lines.push("- Names work where IDs are expected when the spec says how to look them up (e.g. runtime names).");
  lines.push("- --wait on commands that return before the work is done; destructive commands need --yes without a terminal.");
  lines.push("- Credentials: --token, RUNTA_TOKEN, `runta login`; every call is recorded locally (runta activity).");
  lines.push("", "Exit codes:");
  const meaning = {
    ok: "success",
    apiError: "other API error",
    usage: "invalid input or flags (nothing was changed)",
    auth: "missing or invalid credential, or no permission",
    notFound: "not found",
    conflict: "wrong state for this action (e.g. paused runtime); fix the state and retry",
    unavailable: "rate limited or temporarily unavailable after retries",
    timeout: "--wait ran out; the operation may still finish",
    confirm: "destructive command refused: re-run with --yes if the user asked for it",
    failedState: "--wait finished, but the resource ended in a failed state",
  };
  for (const [k, v] of Object.entries(EXIT)) lines.push(`  ${String(v).padEnd(4)}${meaning[k]}`);
  lines.push("  exec: the remote command's exit code; 124 = --timeout; 255 = the session could not run");
  const errs = errorMeanings(spec);
  if (errs) {
    lines.push("", "API error codes:");
    for (const [c, d] of Object.entries(errs)) lines.push(`  ${c.padEnd(22)}${renderText(d, groups)}`);
  }
  return lines.join("\n");
}
