// Generic bridge for WebSocket operations described by `x-websocket.session` in the spec (today: execRuntime).
// The spec says which message starts the session, which carry stdout/stderr, which one ends it; this file
// only moves bytes and exit codes between that protocol and the local process.
import WebSocket from "ws";
import { USER_AGENT } from "./http.js";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Runs one session. Resolves {kind: "exit", code} | {kind: "error", message} | {kind: "http", status, body}
 * | {kind: "incomplete"} | {kind: "timeout"}.
 */
export async function runSession({ url, token, session, argv, options = {}, stdin = null, timeoutSeconds, maxOutput = 0, out = process.stdout, err = process.stderr }) {
    for (let attempt = 1;; attempt++) {
        const result = await once({ url, token, session, argv, options, stdin, timeoutSeconds, maxOutput, out, err });
        // Overloaded upgrades are retried, as the official client does.
        if (result.kind === "http" && [429, 502, 503, 504].includes(result.status) && attempt < 3) {
            await sleep(1000 * attempt);
            continue;
        }
        return result;
    }
}
function once({ url, token, session, argv, options, stdin, timeoutSeconds, maxOutput, out, err }) {
    return new Promise((resolve) => {
        const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}`, "user-agent": USER_AGENT }, maxPayload: 64 * 1024 * 1024 });
        let settled = false;
        let written = 0;
        let truncated = false;
        let timer;
        const done = (r) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            process.off("SIGINT", onSigint);
            resolve(r);
        };
        const send = (m) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
        const terminate = () => session.terminate && send(session.terminate);
        let interrupts = 0;
        const onSigint = () => {
            interrupts++;
            if (interrupts === 1)
                terminate();
            else
                ws.terminate();
        };
        process.on("SIGINT", onSigint);
        ws.on("unexpected-response", (_req, res) => {
            let text = "";
            res.on("data", (c) => (text += c));
            res.on("end", () => {
                let body = null;
                try {
                    body = JSON.parse(text);
                }
                catch {
                    body = text || null;
                }
                done({ kind: "http", status: res.statusCode, body, requestId: res.headers["x-request-id"] });
            });
        });
        ws.on("error", (e) => done({ kind: "http", status: 0, body: { error: { code: "unavailable", message: e.message } } }));
        ws.on("open", () => {
            const start = { ...session.start.message, ...mapOptions(session.start.options, options) };
            start[session.start.argv.command] = argv[0];
            start[session.start.argv.args] = argv.slice(1);
            send(start);
            if (stdin && session.stdin) {
                stdin.on("data", (chunk) => send({ type: session.stdin.type, [session.stdin.field]: Buffer.from(chunk).toString("base64") }));
                stdin.on("end", () => send(session.stdin.end));
            }
            else {
                for (const m of session.noStdin || [])
                    send(m);
            }
            if (timeoutSeconds) {
                timer = setTimeout(() => {
                    // Ask the command to stop; closing the socket also kills it server-side within seconds.
                    terminate();
                    done({ kind: "timeout" });
                    setTimeout(() => ws.close(), 500).unref();
                }, timeoutSeconds * 1000);
            }
        });
        ws.on("message", (data) => {
            let msg;
            try {
                msg = JSON.parse(data.toString());
            }
            catch {
                return;
            }
            const type = msg.type;
            if ((session.ignore || []).includes(type))
                return;
            for (const [stream, spec] of Object.entries(session.output || {})) {
                if (type !== spec.type)
                    continue;
                const bytes = Buffer.from(msg[spec.field] || "", spec.encoding === "base64" ? "base64" : "utf8");
                if (truncated)
                    return;
                const room = maxOutput ? maxOutput - written : bytes.length;
                (stream === "stderr" ? err : out).write(room >= bytes.length ? bytes : bytes.subarray(0, Math.max(room, 0)));
                written += Math.min(bytes.length, Math.max(room, 0));
                if (maxOutput && room < bytes.length) {
                    truncated = true;
                    err.write(`\n[runta] output truncated after ${maxOutput} bytes (use --max-output 0 for all of it)\n`);
                }
                return;
            }
            if (type === session.exit.type)
                done({ kind: "exit", code: msg[session.exit.field], truncated });
            else if (type === session.error.type)
                done({ kind: "error", message: msg[session.error.field] });
        });
        ws.on("close", () => done({ kind: "incomplete" }));
    });
}
// Flag values for fields of the start message (e.g. --env K=V for `env`).
function mapOptions(mapping = {}, options) {
    const out = {};
    for (const [flag, field] of Object.entries(mapping))
        if (options[flag] !== undefined)
            out[field] = options[flag];
    return out;
}
//# sourceMappingURL=ws.js.map