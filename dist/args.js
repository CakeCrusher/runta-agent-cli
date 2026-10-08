// Flags are derived from the operation: path parameters are positional (or --flags), query/header
// parameters and top-level body fields are --flags, nested body fields use dots (--resources.requests.vcpus 2).
import { deref, kebab } from "./spec.js";
import { closest } from "./spec.js";
import { coerce } from "./validate.js";
import { usageError } from "./exit.js";
export const GLOBAL_FLAGS = {
    token: { type: "string", help: "API key for this call (default: RUNTA_TOKEN, then the stored login)" },
    endpoint: { type: "string", help: "API base URL (default: RUNTA_ENDPOINT or https://api.runta.com)" },
    fields: { type: "string", help: "Keep only these comma-separated dotted fields of the JSON output, e.g. data.id,data.status" },
    truncate: { type: "integer", help: "Shorten every string in the output to N characters" },
    pretty: { type: "boolean", help: "Indent JSON output (default when stdout is a terminal)" },
    help: { type: "boolean", help: "Show help for this command" },
};
const COMMAND_FLAGS = {
    data: { type: "string", help: "Request body as JSON, @file, or - for stdin; flags override its fields" },
    "dry-run": { type: "boolean", help: "Print the request that would be sent and stop" },
};
// Merges properties of allOf/oneOf/anyOf branches so every field of every variant gets a flag.
export function bodyFields(spec, schema) {
    const full = deref(spec, schema || {});
    const props = {};
    const required = new Set(full.required || []);
    const visit = (s, top) => {
        if (!s || typeof s !== "object")
            return;
        Object.assign(props, s.properties || {});
        if (top)
            for (const r of s.required || [])
                required.add(r);
        for (const b of s.allOf || [])
            visit(b, top);
        for (const b of [...(s.oneOf || []), ...(s.anyOf || [])])
            visit(b, false);
    };
    visit(full, true);
    return { props, required, schema: full };
}
export function flagTable(spec, cmd) {
    const table = new Map();
    const add = (name, entry) => table.set(kebab(name), { name, ...entry });
    for (const [n, f] of Object.entries(GLOBAL_FLAGS))
        add(n, { kind: "global", schema: { type: f.type } });
    if (cmd.body || cmd.method !== "GET")
        for (const [n, f] of Object.entries(COMMAND_FLAGS))
            add(n, { kind: "global", schema: { type: f.type } });
    if (cmd.destructive)
        add("yes", { kind: "global", schema: { type: "boolean" } });
    if (cmd.wait) {
        add("wait", { kind: "global", schema: { type: "boolean" } });
        add("timeout", { kind: "global", schema: { type: "number" } });
    }
    if (cmd.websocket) {
        add("timeout", { kind: "global", schema: { type: "number" } });
        add("max-output", { kind: "global", schema: { type: "integer" } });
        add("stdin", { kind: "global", schema: { type: "boolean" } });
        for (const [flag, field] of Object.entries(cmd.websocket.session?.start?.options || {})) {
            const props = startMessageProps(spec, cmd);
            add(flag, { kind: "ws", field, schema: props[field] || { type: "string" } });
        }
    }
    for (const p of cmd.params)
        add(p.name, { kind: "param", param: p, schema: deref(spec, p.schema || {}) });
    if (cmd.body?.contentType === "application/json") {
        const { props } = bodyFields(spec, cmd.body.schema);
        for (const [n, s] of Object.entries(props))
            if (!table.has(kebab(n)))
                add(n, { kind: "body", schema: s });
    }
    return table;
}
function startMessageProps(spec, cmd) {
    const ref = cmd.websocket?.clientMessages?.oneOf?.find((r) => /Start$/.test(r.$ref || ""));
    return ref ? deref(spec, ref).properties || {} : {};
}
const isBool = (entry) => flat(entry?.schema).type === "boolean";
export function parseArgs(spec, cmd, argv) {
    const table = flagTable(spec, cmd);
    const positionals = [];
    const values = new Map(); // flag name -> value (arrays and objects accumulate)
    const nested = []; // [path parts, raw value] for dotted body flags
    let trailing = null;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--") {
            trailing = argv.slice(i + 1);
            break;
        }
        if (a === "-h") {
            values.set("help", true);
            continue;
        }
        if (a === "-y" && table.has("yes")) {
            values.set("yes", true);
            continue;
        }
        if (!a.startsWith("--")) {
            positionals.push(a);
            continue;
        }
        let [key, inline] = a.slice(2).split(/=(.*)/s, 2);
        const norm = key.replace(/_/g, "-");
        const dotted = norm.includes(".");
        const head = dotted ? norm.split(".")[0] : norm;
        const entry = table.get(head) || table.get(norm);
        if (!entry) {
            const hint = closest(norm, [...table.keys()]);
            throw usageError(`unknown flag --${key}${hint ? `; did you mean --${hint}?` : ""}`, { hint: `runta ${cmd.group} ${cmd.name} --help` });
        }
        let raw = inline;
        if (raw === undefined) {
            if (isBool(entry) && !dotted && !(argv[i + 1] === "true" || argv[i + 1] === "false"))
                raw = "true";
            else if (i + 1 < argv.length)
                raw = argv[++i];
            else
                throw usageError(`--${key} needs a value`);
        }
        if (dotted) {
            if (entry.kind !== "body")
                throw usageError(`--${key}: only body fields take dotted sub-fields`);
            // The first part names the body field like any flag (kebab or JSON spelling); the parts after the dot must be
            // the exact JSON names, checked against the schema before anything is sent.
            const parts = [entry.name, ...key.split(".").slice(1)];
            checkNestedPath(entry.schema, parts, key, cmd);
            nested.push([parts, raw, entry]);
            continue;
        }
        values.set(entry.name, accumulate(values.get(entry.name), raw, entry.schema));
    }
    return { table, positionals, values, nested, trailing };
}
export const flat = (s) => (s?.allOf?.length === 1 ? { ...s.allOf[0], ...s, allOf: undefined } : s || {});
// Repeated flags build arrays (--item a --item b) and string maps (--env A=1 --env B=2); a plain value for an
// object with one required field fills that field (--image codex -> {"id": "codex"}).
function accumulate(prev, raw, rawSchema = {}) {
    const schema = flat(rawSchema);
    const req = schema.required || [];
    if (schema.type === "object" && req.length === 1 && !schema.additionalProperties && !/^\s*\{/.test(raw)) {
        return { ...(prev || {}), [req[0]]: coerce(raw, flat(schema.properties?.[req[0]])) };
    }
    if (schema.type === "array" && !/^\s*\[/.test(raw)) {
        return [...(prev || []), coerce(raw, schema.items || {})];
    }
    if (schema.type === "object" && schema.additionalProperties && !/^\s*\{/.test(raw)) {
        const eq = raw.indexOf("=");
        if (eq < 1)
            throw usageError(`expected KEY=VALUE, got "${raw}"`);
        return { ...(prev || {}), [raw.slice(0, eq)]: raw.slice(eq + 1) };
    }
    return coerce(raw, schema);
}
// A field inside a body field is named exactly as in the API's JSON; a wrong name is an input error that says the right one.
function checkNestedPath(schema, parts, key, cmd) {
    let s = flat(schema);
    for (let i = 1; i < parts.length; i++) {
        const where = parts.slice(0, i).join(".");
        if (s.type === "array")
            throw usageError(`--${key}: ${where} is a list; give it as JSON or in --data`, { hint: `runta ${cmd.group} ${cmd.name} --help` });
        const branches = [s, ...(s.allOf || []), ...(s.oneOf || []), ...(s.anyOf || [])].map(flat);
        const names = [...new Set(branches.flatMap((b) => Object.keys(b.properties || {})))];
        if (!names.length && s.additionalProperties)
            return; // a free-form map: any key is valid
        const next = branches.map((b) => b.properties?.[parts[i]]).find(Boolean);
        if (!next) {
            const hint = closest(parts[i], names);
            throw usageError(`--${key}: ${where} has no field '${parts[i]}'${hint ? `; did you mean '${hint}'?` : ""} (fields inside a body field use their exact JSON names: ${names.join(", ")})`, { hint: `runta ${cmd.group} ${cmd.name} --help` });
        }
        s = flat(next);
    }
}
export function setNested(target, parts, value) {
    let node = target;
    for (const p of parts.slice(0, -1))
        node = node[p] && typeof node[p] === "object" ? node[p] : (node[p] = {});
    node[parts[parts.length - 1]] = value;
}
// Type for a dotted body path, following the (dereferenced) schema as far as it goes.
export function schemaAt(schema, parts) {
    let s = schema;
    for (const p of parts) {
        if (!s)
            return {};
        const branches = [s, ...(s.allOf || []), ...(s.oneOf || []), ...(s.anyOf || [])];
        s = branches.map((b) => b.properties?.[p]).find(Boolean);
        if (s?.allOf?.length === 1)
            s = { ...s.allOf[0], ...s, allOf: undefined };
    }
    return s || {};
}
//# sourceMappingURL=args.js.map