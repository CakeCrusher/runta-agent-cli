// One HTTP path for every command: auth header, user agent, bounded retries, parsed body.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, EXIT } from "./exit.js";
const PKG = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));
export const VERSION = PKG.version;
export const USER_AGENT = `runta-agent-cli/${VERSION} (node ${process.versions.node}; ${process.platform})`;
const RETRYABLE = new Set([429, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function buildUrl(endpoint, path, query = {}) {
    const url = new URL(path.replace(/^\//, ""), endpoint.endsWith("/") ? endpoint : endpoint + "/");
    for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null)
            continue;
        for (const item of Array.isArray(v) ? v : [v])
            url.searchParams.append(k, String(item));
    }
    return url.toString();
}
export async function request({ method, url, token, headers = {}, body, contentType, timeoutMs = 60_000, stream = false }) {
    const h = { "user-agent": USER_AGENT, accept: "application/json", ...headers };
    if (token)
        h.authorization = `Bearer ${token}`;
    let payload;
    if (body !== undefined) {
        h["content-type"] = contentType || "application/json";
        payload = h["content-type"] === "application/json" ? JSON.stringify(body) : body;
    }
    const idempotent = ["GET", "HEAD", "PUT", "DELETE"].includes(method) || Object.keys(h).some((k) => k.toLowerCase() === "idempotency-key");
    let attempt = 0;
    for (;;) {
        attempt++;
        let res;
        try {
            res = await fetch(url, { method, headers: h, body: payload, signal: stream ? undefined : AbortSignal.timeout(timeoutMs) });
        }
        catch (err) {
            if (idempotent && attempt < 3) {
                await sleep(500 * 2 ** attempt);
                continue;
            }
            const reason = err.name === "TimeoutError" ? `no response within ${timeoutMs / 1000}s` : err.cause?.code || err.message;
            throw new CliError("unavailable", `${method} ${url} failed: ${reason}`, EXIT.unavailable);
        }
        if (RETRYABLE.has(res.status) && idempotent && attempt < 3) {
            const after = Number(res.headers.get("retry-after"));
            await res.body?.cancel();
            await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 500 * 2 ** attempt);
            continue;
        }
        const requestId = res.headers.get("x-request-id");
        if (stream && res.ok)
            return { status: res.status, headers: res.headers, res, requestId, attempts: attempt };
        const type = res.headers.get("content-type") || "";
        if (res.ok && type.includes("octet-stream")) {
            const buffer = Buffer.from(await res.arrayBuffer());
            return { status: res.status, headers: res.headers, buffer, requestId, attempts: attempt, contentType: type };
        }
        const text = await res.text();
        let parsed = null;
        if (text && type.includes("json")) {
            try {
                parsed = JSON.parse(text);
            }
            catch {
                parsed = null;
            }
        }
        return { status: res.status, headers: res.headers, body: parsed, text, requestId, attempts: attempt, contentType: type };
    }
}
//# sourceMappingURL=http.js.map