// Loads the bundled OpenAPI spec and turns every operation into a command. Nothing here knows about a
// specific endpoint: names, flags, waits, guards and lookups all come from the spec.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SPEC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "spec");
const METHODS = ["get", "post", "put", "patch", "delete", "head"];

export function loadSpec(env = process.env) {
  const file = env.RUNTA_SPEC_FILE
    || join(SPEC_DIR, env.RUNTA_SPEC === "original" ? "runta-openapi.original.json" : "runta-openapi.json");
  const spec = JSON.parse(readFileSync(file, "utf8"));
  spec["x-loaded-from"] = file;
  return spec;
}

export function resolveRef(spec, ref) {
  if (!ref.startsWith("#/")) throw new Error(`external $ref not supported: ${ref}`);
  return ref.slice(2).split("/").reduce((node, key) => node?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], spec);
}

// Fully inlines $refs (cycles are cut with a {$ref} stub) so help and validation see one schema.
export function deref(spec, node, seen = new Set()) {
  if (Array.isArray(node)) return node.map((n) => deref(spec, n, seen));
  if (!node || typeof node !== "object") return node;
  if (node.$ref) {
    if (seen.has(node.$ref)) return { $ref: node.$ref };
    const next = new Set(seen).add(node.$ref);
    return deref(spec, resolveRef(spec, node.$ref), next);
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = deref(spec, v, seen);
  return out;
}

// --- naming -------------------------------------------------------------------------------------------
export const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[\s_]+/g, "-").toLowerCase();
const words = (s) => kebab(s).split("-").filter(Boolean);
const singular = (w) => (w.endsWith("ies") ? w.slice(0, -3) + "y" : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
// Words that add nothing to a command name (every event is an organization event).
const FILLER = new Set(["organization"]);

export const groupName = (tag) => tag.trim().toLowerCase().replace(/\s+/g, "-");

// Candidate names, most preferred first: drop the group's own words ("createCloudAgentRun" in Cloud Agents
// -> "create-run"), then also the parent resource of the path ("readRuntimeFile" on /runtimes/{id}/files ->
// "read"), falling back to the full operationId when names collide.
function dropWords(tokens, drop) {
  // Removes whole words, also when the spec splits one word in two ("GitHub" -> "git", "hub").
  const out = [tokens[0]];
  for (let i = 1; i < tokens.length; i++) {
    const two = tokens[i] + (tokens[i + 1] || "");
    if (tokens[i + 1] && drop.has(singular(two))) { i++; continue; }
    if (!drop.has(singular(tokens[i]))) out.push(tokens[i]);
  }
  return out;
}

function nameCandidates(operationId, tag, path) {
  const tokens = words(operationId);
  const groupWords = new Set(tag.toLowerCase().split(/\s+/).map(singular));
  const base = dropWords(tokens, new Set([...groupWords, ...FILLER]));
  // Parent resources (a collection followed by its {id} and more path) are context, not the command's subject,
  // but only drop them when the command also names its own resource (the last literal path segment).
  const segs = path.split("/").filter(Boolean);
  const literal = segs.filter((s) => !s.startsWith("{"));
  const own = singular(literal[literal.length - 1].replace(/-/g, ""));
  const parents = new Set(segs.filter((s, i) => segs[i + 1]?.startsWith("{") && i + 2 < segs.length).map((s) => singular(s.replace(/-/g, ""))));
  parents.delete(own);
  const short = tokens.join("").includes(own) ? dropWords(base, parents) : base;
  return [short.join("-"), base.join("-"), kebab(operationId)];
}

// --- commands -------------------------------------------------------------------------------------------
export function buildCommands(spec) {
  const groups = new Map();
  for (const [path, item] of Object.entries(spec.paths || {})) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const tag = op.tags?.[0] || "misc";
      const group = groupName(tag);
      if (!groups.has(group)) {
        const tagInfo = (spec.tags || []).find((t) => t.name === tag);
        groups.set(group, { name: group, tag, description: tagInfo?.description || "", commands: new Map(), aliases: [] });
      }
      const params = [...(item.parameters || []), ...(op.parameters || [])].map((p) => (p.$ref ? resolveRef(spec, p.$ref) : p));
      const body = op.requestBody?.$ref ? resolveRef(spec, op.requestBody.$ref) : op.requestBody;
      const bodyType = body?.content ? Object.keys(body.content)[0] : null;
      const okResponses = Object.entries(op.responses || {}).filter(([code]) => /^[12]/.test(code));
      const responseTypes = okResponses.flatMap(([, r]) => Object.keys(r.content || {}));
      groups.get(group).commands.set(op.operationId, {
        operationId: op.operationId,
        method: method.toUpperCase(),
        path,
        group,
        tag,
        summary: op.summary || "",
        description: op.description || "",
        params,
        body: body ? { required: !!body.required, contentType: bodyType, schema: body.content?.[bodyType]?.schema } : null,
        responseTypes,
        sse: responseTypes.includes("text/event-stream"),
        binary: responseTypes.includes("application/octet-stream"),
        websocket: op["x-websocket"] || null,
        wait: op["x-wait"] || null,
        destructive: op["x-destructive"] ?? method === "delete",
        // No security requirement (or an empty one) means the operation needs no credential.
        noAuth: (op.security ?? spec.security ?? []).length === 0 || (op.security ?? spec.security).some((r) => Object.keys(r).length === 0),
      });
    }
  }
  for (const g of groups.values()) {
    const cmds = [...g.commands.values()];
    const cands = new Map(cmds.map((c) => [c, nameCandidates(c.operationId, g.tag, c.path)]));
    const count = (k, n) => cmds.filter((c) => cands.get(c)[k] === n).length;
    const named = new Map();
    for (const cmd of cmds) {
      const [short, base, full] = cands.get(cmd);
      const shortOk = count(0, short) === 1 && !cmds.some((o) => o !== cmd && cands.get(o)[1] === short);
      cmd.name = shortOk ? short : count(1, base) === 1 ? base : full;
      named.set(cmd.name, cmd);
    }
    g.commands = new Map([...named.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }
  // Unique trailing words become group aliases: "cloud-agents" is also "agents".
  const all = [...groups.keys()];
  for (const g of groups.values()) {
    const w = g.name.split("-");
    for (let i = 1; i < w.length; i++) {
      const suffix = w.slice(i).join("-");
      if (all.filter((n) => n === suffix || n.endsWith("-" + suffix)).length === 1 && !groups.has(suffix)) g.aliases.push(suffix);
    }
  }
  return new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function findGroup(groups, name) {
  if (groups.has(name)) return groups.get(name);
  for (const g of groups.values()) if (g.aliases.includes(name)) return g;
  return null;
}

export function commandByOperationId(groups, operationId) {
  for (const g of groups.values()) for (const c of g.commands.values()) if (c.operationId === operationId) return c;
  return null;
}

// Closest name by edit distance, for "did you mean" hints.
export function closest(name, candidates) {
  const dist = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  };
  let best = null;
  for (const c of candidates) {
    const score = c.includes(name) || name.includes(c) ? 0 : dist(name, c);
    if (score <= Math.max(2, Math.floor(name.length / 3)) && (!best || score < best.score)) best = { c, score };
  }
  return best?.c || null;
}
