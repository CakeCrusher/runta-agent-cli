// Spec-declared help for filling parameters: names become UUIDs (x-name-lookups) and values the caller
// shouldn't have to track are read just in time (x-default-from).
import { CliError, EXIT, exitForStatus } from "./exit.js";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => UUID.test(String(v));
export function pointer(doc, ptr) {
    if (!ptr || ptr === "/")
        return doc;
    return ptr
        .split("/")
        .slice(1)
        .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
        .reduce((node, key) => (node == null ? undefined : node[key]), doc);
}
// OpenAPI runtime expressions: $request.path.x, $request.query.x, $request.body#/p, $response.body#/p.
export function evaluate(expr, ctx) {
    if (typeof expr !== "string" || !expr.startsWith("$"))
        return expr;
    let m;
    if ((m = expr.match(/^\$request\.(path|query|header)\.(.+)$/)))
        return ctx.request?.[m[1]]?.[m[2]];
    if ((m = expr.match(/^\$(request|response)\.body(?:#(.*))?$/)))
        return pointer(ctx[m[1]]?.body, m[2] || "");
    return undefined;
}
export function evaluateAll(map = {}, ctx) {
    return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, evaluate(v, ctx)]));
}
function apiFailure(res, what) {
    const err = res.body?.error;
    return new CliError(err?.code || "unavailable", `${what} failed: ${err?.message || `HTTP ${res.status}`}`, exitForStatus(res.status), { request_id: res.requestId });
}
// Finds the UUID for a name using the listing the spec names for this parameter (x-name-lookups).
export async function lookupId(client, paramName, value) {
    const lookup = (client.spec["x-name-lookups"] || {})[paramName];
    if (!lookup || value === undefined || isUuid(value))
        return value;
    const matches = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
        const q = {};
        if (cursor)
            q[lookup.next?.param || "after"] = cursor;
        if (client.command(lookup.operationId).params.some((x) => x.name === "limit"))
            q.limit = 100;
        const res = await client.call(lookup.operationId, q);
        if (res.status >= 400)
            throw apiFailure(res, `looking up ${paramName} "${value}" with ${lookup.operationId}`);
        for (const item of pointer(res.body, lookup.items) || []) {
            if ((lookup.match || []).some((f) => item?.[f] === value))
                matches.push(item);
        }
        cursor = lookup.next ? pointer(res.body, lookup.next.cursor) : null;
        if (!cursor)
            break;
    }
    if (matches.length === 0) {
        throw new CliError("not_found", `no ${paramName.replace(/_id$/, "")} named "${value}" (looked up by ${lookup.match.join("/")} with ${lookup.operationId}); pass its UUID or check the name`, EXIT.notFound);
    }
    if (matches.length > 1) {
        throw new CliError("invalid_argument", `${matches.length} matches for "${value}"; pass one UUID`, EXIT.usage, { matches: matches.map((m) => pointer(m, lookup.id)) });
    }
    return pointer(matches[0], lookup.id);
}
// Path parameters and top-level body fields whose names have a lookup accept names as well as UUIDs.
export async function resolveNames(client, cmd, pathValues, onResolved, body) {
    for (const p of cmd.params.filter((x) => x.in === "path")) {
        const before = pathValues[p.name];
        pathValues[p.name] = await lookupId(client, p.name, before);
        if (pathValues[p.name] !== before)
            onResolved?.(p.name, before, pathValues[p.name]);
    }
    if (body && typeof body === "object" && !Buffer.isBuffer(body)) {
        for (const key of Object.keys(body)) {
            const before = body[key];
            if (typeof before !== "string")
                continue;
            body[key] = await lookupId(client, key, before);
            if (body[key] !== before)
                onResolved?.(key, before, body[key]);
        }
    }
}
export async function fillDefaults(client, cmd, values) {
    for (const p of cmd.params) {
        const from = p["x-default-from"];
        if (!from || values[p.name] !== undefined)
            continue;
        const ctx = { request: { path: values, query: values } };
        const res = await client.call(from.operationId, evaluateAll(from.parameters, ctx));
        if (res.status >= 400)
            throw apiFailure(res, `reading ${p.name} with ${from.operationId}`);
        values[p.name] = evaluate(from.value, { response: { body: res.body } });
    }
}
//# sourceMappingURL=resolve.js.map