// Checks request bodies and parameters against the spec's own schemas before anything is sent.
import Ajv from "ajv";

const cache = new WeakMap();

function ajvFor(spec) {
  if (!cache.has(spec)) {
    // OpenAPI 3.0 schemas: `nullable` is understood by Ajv; formats like uint64 are documentation only.
    // ajv is CommonJS; under NodeNext its default import is typed as the module, though at run time it is the class.
    const ajv = new (Ajv as any)({ strict: false, allErrors: true, validateFormats: false });
    ajv.addSchema({ $id: "runta", components: spec.components || {} });
    cache.set(spec, ajv);
  }
  return cache.get(spec);
}

const rebase = (node) => {
  if (Array.isArray(node)) return node.map(rebase);
  if (!node || typeof node !== "object") return node;
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, k === "$ref" && typeof v === "string" && v.startsWith("#/") ? "runta" + v : rebase(v)]));
};

function compile(spec, schema) {
  try {
    return ajvFor(spec).compile({ $id: undefined, ...rebase(schema) });
  } catch {
    return null; // A schema Ajv can't compile is not a reason to block the request.
  }
}

// Turns Ajv's errors into short, path-first messages. For oneOf bodies the branch with the fewest
// complaints is the one the caller most likely meant, so only its errors are shown.
function summarize(errors, where) {
  const branches = new Map();
  for (const e of errors) {
    if (e.keyword === "oneOf" || e.keyword === "anyOf") continue;
    const branch = e.schemaPath.match(/^runta#\/components\/schemas\/([^/]+)/)?.[1] || e.schemaPath.split("/").slice(0, 2).join("/");
    if (!branches.has(branch)) branches.set(branch, []);
    branches.get(branch).push(e);
  }
  const best = [...branches.values()].sort((a, b) => a.length - b.length)[0] || errors;
  return best.slice(0, 6).map((e) => {
    const path = `${where}${e.instancePath.replace(/\//g, ".")}`;
    const extra = e.params?.allowedValues ? ` (${e.params.allowedValues.join(", ")})` : e.params?.additionalProperty ? ` '${e.params.additionalProperty}'` : "";
    return { path, message: `${e.message}${extra}` };
  });
}

export function validateBody(spec, schema, body) {
  if (!schema || body === undefined) return [];
  const v = compile(spec, schema);
  if (!v || v(body)) return [];
  return summarize(v.errors, "body");
}

export function validateParam(spec, param, value) {
  if (!param.schema) return [];
  const v = compile(spec, param.schema);
  if (!v || v(value)) return [];
  return summarize(v.errors, param.name);
}

// Flag values arrive as strings; give them the type the schema asks for.
export function coerce(value: unknown, schema: Record<string, any> = {}) {
  const type = schema.type || (schema.enum ? typeof schema.enum[0] : undefined);
  if (typeof value !== "string") return value;
  if (type === "integer" || type === "number") {
    const n = Number(value);
    return Number.isFinite(n) && value.trim() !== "" ? n : value;
  }
  if (type === "boolean") return value === "true" || value === "1" ? true : value === "false" || value === "0" ? false : value;
  if (type === "object" || type === "array" || (!type && /^\s*[[{]/.test(value))) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}
