// Loads the bundled OpenAPI spec and turns every operation into a command. Nothing here knows about a
// specific endpoint: names, flags, waits, guards and lookups all come from the spec.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command, Env, Group, Groups, OpenApi } from "./types.js";

const SPEC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "spec");
const METHODS = ["get", "post", "put", "patch", "delete", "head"];

export function loadSpec(env: Env = process.env): OpenApi {
  const file = env.RUNTA_SPEC_FILE
    || join(SPEC_DIR, env.RUNTA_SPEC === "original" ? "runta-openapi.original.json" : "runta-openapi.json");
  const spec = JSON.parse(readFileSync(file, "utf8"));
  spec["x-loaded-from"] = file;
  return spec;
}

export function resolveRef(spec: OpenApi, ref: string): any {
  if (!ref.startsWith("#/")) throw new Error(`external $ref not supported: ${ref}`);
  return ref.slice(2).split("/").reduce((node, key) => node?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], spec);
}

// Fully inlines $refs (cycles are cut with a {$ref} stub) so help and validation see one schema.
export function deref(spec: OpenApi, node: any, seen: Set<string> = new Set()): any {
  if (Array.isArray(node)) return node.map((n) => deref(spec, n, seen));
  if (!node || typeof node !== "object") return node;
  if (node.$ref) {
    if (seen.has(node.$ref)) return { $ref: node.$ref };
    const next = new Set(seen).add(node.$ref);
    return deref(spec, resolveRef(spec, node.$ref), next);
  }
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(node)) out[k] = deref(spec, v, seen);
  return out;
}

// --- naming -------------------------------------------------------------------------------------------
export const kebab = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[\s_]+/g, "-").toLowerCase();
const words = (s: string): string[] => kebab(s).split("-").filter(Boolean);
const singular = (w: string): string => (w.endsWith("ies") ? w.slice(0, -3) + "y" : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
// Words that add nothing to a command name (every event is an organization event).
const FILLER = new Set(["organization"]);

export const groupName = (tag: string): string => tag.trim().toLowerCase().replace(/\s+/g, "-");

// Candidate names, most preferred first: drop the group's own words ("createCloudAgentRun" in Cloud Agents
// -> "create-run"), then also the parent resource of the path ("readRuntimeFile" on /runtimes/{id}/files ->
// "read"), falling back to the full operationId when names collide.
function dropWords(tokens: string[], drop: Set<string>): string[] {
  // Removes whole words, also when the spec splits one word in two ("GitHub" -> "git", "hub").
  const out = [tokens[0]];
  for (let i = 1; i < tokens.length; i++) {
    const two = tokens[i] + (tokens[i + 1] || "");
    if (tokens[i + 1] && drop.has(singular(two))) { i++; continue; }
    if (!drop.has(singular(tokens[i]))) out.push(tokens[i]);
  }
  return out;
}

function nameCandidates(operationId: string, tag: string, path: string): string[] {
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
export function buildCommands(spec: OpenApi): Groups {
  const groups: Groups = new Map();
  for (const [path, item] of Object.entries<any>(spec.paths || {})) {
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
      const okResponses = Object.entries<any>(op.responses || {}).filter(([code]) => /^[12]/.test(code));
      const responseTypes = okResponses.flatMap(([, r]) => Object.keys(r.content || {}));
      groups.get(group)!.commands.set(op.operationId, {
        operationId: op.operationId,
        method: method.toUpperCase(),
        path,
        group,
        tag,
        summary: op.summary || "",
        description: op.description || "",
        params,
        body: body ? { required: !!body.required, contentType: bodyType, schema: body.content?.[bodyType!]?.schema } : null,
        responseTypes,
        sse: responseTypes.includes("text/event-stream"),
        binary: responseTypes.includes("application/octet-stream"),
        websocket: op["x-websocket"] || null,
        wait: op["x-wait"] || null,
        destructive: op["x-destructive"] ?? method === "delete",
        // No security requirement (or an empty one) means the operation needs no credential.
        noAuth: (op.security ?? spec.security ?? []).length === 0 || (op.security ?? spec.security).some((r) => Object.keys(r).length === 0),
      } as Command);
    }
  }
  for (const g of groups.values()) {
    const cmds = [...g.commands.values()];
    const cands = new Map(cmds.map((c) => [c, nameCandidates(c.operationId, g.tag, c.path)]));
    const count = (k: number, n: string) => cmds.filter((c) => cands.get(c)![k] === n).length;
    const named = new Map<string, Command>();
    for (const cmd of cmds) {
      const [short, base, full] = cands.get(cmd)!;
      const shortOk = count(0, short) === 1 && !cmds.some((o) => o !== cmd && cands.get(o)![1] === short);
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

export function findGroup(groups: Groups, name: string): Group | null {
  if (groups.has(name)) return groups.get(name)!;
  for (const g of groups.values()) if (g.aliases.includes(name)) return g;
  return null;
}

export function commandByOperationId(groups: Groups, operationId: string): Command | null {
  for (const g of groups.values()) for (const c of g.commands.values()) if (c.operationId === operationId) return c;
  return null;
}

// Closest name by edit distance, for "did you mean" hints.
export function closest(name: string, candidates: Iterable<string>): string | null {
  const dist = (a: string, b: string): number => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  };
  // Separators don't count (model-provider-protocol vs model_provider_protocol), and containment only counts for
  // names long enough not to match by accident ("id" is inside "provider").
  const norm = (s: string): string => s.toLowerCase().replace(/[-_\s]/g, "");
  let best: { c: string; score: number } | null = null;
  for (const c of candidates) {
    const a = norm(name), b = norm(c);
    const score = a === b ? -1 : Math.min(a.length, b.length) >= 4 && (b.includes(a) || a.includes(b)) ? 0 : dist(a, b);
    if (score <= Math.max(2, Math.floor(name.length / 3)) && (!best || score < best.score)) best = { c, score };
  }
  return best?.c || null;
}

// Verbs other CLIs (and agents) use for the action a generated command performs.
const SYNONYMS: Record<string, string> = {
  upload: "write", put: "write", download: "read", cat: "read", ls: "list", ps: "list", rm: "delete", remove: "delete",
  del: "delete", inspect: "get", show: "get", describe: "get", info: "get", new: "create", add: "create", run: "create",
  kill: "stop", halt: "stop", update: "patch",
};

export function suggestCommand(group: Group, name: string): string | null {
  const names = [...group.commands.keys()];
  const [verb, ...rest] = name.split("-");
  const mapped = [SYNONYMS[verb] || verb, ...rest].join("-");
  if (group.commands.has(mapped)) return mapped;
  const prefixed = names.filter((n) => n.startsWith(mapped + "-"));
  if (prefixed.length === 1) return prefixed[0];
  return closest(mapped, names) || closest(name, names);
}

// The official CLI's top-level verbs all act on runtimes (or files); point their habits at the generated commands.
export const OFFICIAL_VERBS: Record<string, string> = {
  ps: "runtimes list", run: "runtimes create", rm: "runtimes delete", inspect: "runtimes get", exec: "runtimes exec",
  pause: "runtimes pause", resume: "runtimes resume", boot: "runtimes start", shutdown: "runtimes stop",
  cp: "files write / files read", ports: "runtimes patch (--ingress-specs)",
};

// Commands whose name, flags or summary mention a word, best matches first ("ingress" -> create/patch via --ingress-specs).
export function relatedCommands(spec: OpenApi, groups: Groups, word: string, { only, limit = 3 }: { only?: Group | null; limit?: number } = {}): string[] {
  const w = word.toLowerCase().replace(/^-+/, "").replace(/-/g, "_");
  if (w.length < 3) return [];
  const hits: { score: number; text: string }[] = [];
  for (const g of groups.values()) {
    if (only && g !== only) continue;
    for (const c of g.commands.values()) {
      const body = c.body?.schema ? deref(spec, c.body.schema) : {};
      const props = Object.keys({ ...(body.properties || {}), ...Object.assign({}, ...[...(body.oneOf || []), ...(body.allOf || [])].map((b) => b.properties || {})) });
      const flags = [...c.params.map((p) => p.name), ...props];
      const flagHit = flags.find((f) => f.toLowerCase().includes(w));
      const score = c.name.replace(/-/g, "_").includes(w) ? 3 : flagHit ? 2 : c.summary.toLowerCase().includes(w.replace(/_/g, " ")) ? 1 : 0;
      if (score) hits.push({ score, text: `runta ${g.name} ${c.name}${flagHit ? ` (--${kebab(flagHit)})` : ""}` });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit).map((h) => h.text);
}
