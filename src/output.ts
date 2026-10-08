// stdout carries exactly what the API returned (optionally narrowed with --fields); everything else is stderr.

// Keeps only the given dotted paths. Arrays are mapped, so "data.id" on a list keeps [{id}, ...].
export function project(value, fields) {
  if (!fields?.length) return value;
  if (Array.isArray(value)) return value.map((item) => project(item, fields));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const f of fields) copyPath(out, value, f.split("."));
  return out;
}

function copyPath(target: any, source: any, [head, ...rest]: string[]) {
  const src = source?.[head];
  if (src === undefined) return;
  if (!rest.length) {
    target[head] = src;
  } else if (Array.isArray(src)) {
    const arr = (target[head] ||= src.map(() => ({})));
    src.forEach((item, i) => item && typeof item === "object" && copyPath(arr[i], item, rest));
  } else if (src && typeof src === "object") {
    copyPath((target[head] ||= {}), src, rest);
  }
}

export function truncateStrings(value, max) {
  if (!max) return value;
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}…[+${value.length - max} chars]` : value;
  if (Array.isArray(value)) return value.map((v) => truncateStrings(v, max));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncateStrings(v, max)]));
  return value;
}

export function render(value: unknown, { fields, truncate, pretty }: { fields?: string[]; truncate?: number | false; pretty?: boolean } = {}) {
  const v = truncateStrings(project(value, fields), truncate);
  return pretty ? JSON.stringify(v, null, 2) : JSON.stringify(v);
}

export function printJson(value, opts = {}) {
  process.stdout.write(render(value, opts) + "\n");
}

export function note(message) {
  process.stderr.write(`[runta] ${message}\n`);
}
