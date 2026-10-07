// A small fake Runta API (HTTP + the exec WebSocket) and a helper that runs the real CLI against it.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "runta.js");
export const RT_ID = "01a11463-0733-7773-9f40-3ae5103df8dd";
export const AGENT_ID = "01a11464-0000-7000-8000-000000000001";
export const RUN_ID = "01a11464-0000-7000-8000-000000000002";

export async function fakeApi(overrides = {}) {
  const calls = [];
  let runtime = { id: RT_ID, display_name: "demo", status: "running", revision: 7, error_code: null };
  let polls = 0;
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", "x-request-id": `req-${calls.length}`, ...headers });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const routes = {
    "GET /v2/me": (req, res) => send(res, 200, { data: { user_id: "u1", email: "dev@example.com", display_name: null } }),
    "GET /v2/runtimes": (req, res) => send(res, 200, { data: [runtime], pagination: { next_cursor: null, has_more: false } }),
    [`GET /v2/runtimes/${RT_ID}`]: (req, res) => {
      polls++;
      if (runtime.status === "pausing" && polls > 2) runtime = { ...runtime, status: "paused", revision: 8 };
      send(res, 200, { data: runtime });
    },
    [`POST /v2/runtimes/${RT_ID}/pause`]: (req, res, url) => {
      if (url.searchParams.get("expected_revision") !== "7") return send(res, 409, { error: { code: "failed_precondition", message: "stale revision" }, request_id: "r" });
      runtime = { ...runtime, status: "pausing" };
      send(res, 200, { data: runtime });
    },
    [`DELETE /v2/runtimes/${RT_ID}`]: (req, res) => send(res, 202, { data: { ...runtime, status: "deleting" } }),
    "POST /v2/runtimes": (req, res, url, body) => send(res, 201, { data: { ...runtime, id: RT_ID, display_name: body.name, status: "creating" } }, { "x-seen-idempotency-key": req.headers["idempotency-key"] || "" }),
    [`POST /v2/agents/${AGENT_ID}/runs`]: (req, res) => send(res, 202, { id: RUN_ID, agent_id: AGENT_ID, status: "queued", prompt: "x", result: null, error: null, parent_run_id: null, dsh_session_id: null, created_at: null, updated_at: null }),
    [`GET /v2/agents/${AGENT_ID}/runs/${RUN_ID}`]: (req, res) => send(res, 200, { id: RUN_ID, agent_id: AGENT_ID, status: "failed", prompt: "x", result: null, error: "provider key rejected", parent_run_id: null, dsh_session_id: null, created_at: null, updated_at: null }),
    [`GET /v2/agents/${AGENT_ID}/runs/${RUN_ID}/events`]: (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: run.status\nid: 1\ndata: {"status":"running"}\n\n');
      res.end('event: run.status\nid: 2\ndata: {"status":"finished","stop_reason":"end_turn"}\n\n');
    },
    "GET /v2/missing": (req, res) => send(res, 404, { error: { code: "not_found", message: "nope" }, request_id: "r404" }),
    ...overrides,
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return send(res, 404, { error: { code: "not_found", message: `no route ${req.method} ${url.pathname}` }, request_id: "rx" });
    if (req.headers.authorization !== "Bearer test-key" && url.pathname !== "/healthz") return send(res, 401, { error: { code: "unauthenticated", message: "invalid bearer credential" }, request_id: "r401" });
    route(req, res, url, body);
  });
  // exec: echo the command line back on stdout, a line on stderr, then exit with code 3.
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.headers.authorization !== "Bearer test-key") {
      socket.end("HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\n\r\n" + JSON.stringify({ error: { code: "unauthenticated", message: "bad key" } }));
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (data) => {
        const m = JSON.parse(data.toString());
        calls.push({ ws: m });
        if (m.type !== "start") return;
        ws.send(JSON.stringify({ type: "stdout", data_base64: Buffer.from(`${m.command} ${m.args.join(" ")}\n`).toString("base64") }));
        ws.send(JSON.stringify({ type: "stderr", data_base64: Buffer.from(`env=${JSON.stringify(m.env)}\n`).toString("base64") }));
        ws.send(JSON.stringify({ type: "exit", code: 3 }));
        ws.close();
      });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

export function runCli(args, { endpoint, env = {}, input } = {}) {
  const home = mkdtempSync(join(tmpdir(), "runta-cli-test-"));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: join(home, "config"),
        XDG_STATE_HOME: join(home, "state"),
        RUNTA_CREDENTIAL_STORE: "file",
        RUNTA_NO_UPDATE_CHECK: "1",
        RUNTA_TOKEN: "test-key",
        ...(endpoint ? { RUNTA_ENDPOINT: endpoint } : {}),
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr, home, json: () => JSON.parse(stdout) }));
  });
}
