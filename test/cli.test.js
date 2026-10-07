import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeApi, runCli, AGENT_ID, RUN_ID, RT_ID } from "./helpers.js";

let api;
before(async () => (api = await fakeApi()));
after(() => api.close());
const run = (args, opts = {}) => runCli(args, { endpoint: api.url, ...opts });

test("prints the API's JSON unchanged and exits 0", async () => {
  const r = await run(["identity", "get-me"]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json(), { data: { user_id: "u1", email: "dev@example.com", display_name: null } });
});

test("--fields keeps only the requested paths, also inside arrays", async () => {
  const r = await run(["runtimes", "list", "--fields", "data.display_name,data.status"]);
  assert.deepEqual(r.json(), { data: [{ display_name: "demo", status: "running" }] });
});

test("a runtime name is looked up and replaced by its UUID", async () => {
  const r = await run(["runtimes", "get", "demo", "--fields", "data.id"]);
  assert.equal(r.code, 0);
  assert.equal(r.json().data.id, RT_ID);
  assert.match(r.stderr, /runtime_id "demo" is/);
});

test("an unknown name is a not_found error with exit 4", async () => {
  const r = await run(["runtimes", "get", "nope"]);
  assert.equal(r.code, 4);
  assert.equal(r.json().error.code, "not_found");
});

test("API errors are printed as returned and mapped to exit codes", async () => {
  const r = await run(["api", "GET", "/v2/missing"]);
  assert.equal(r.code, 4);
  assert.equal(r.json().request_id, "r404");
  const bad = await run(["identity", "get-me"], { env: { RUNTA_TOKEN: "wrong" } });
  assert.equal(bad.code, 3);
  assert.equal(bad.json().error.code, "unauthenticated");
});

test("no credential at all is an auth error before any request", async () => {
  const before = api.calls.length;
  const r = await run(["identity", "get-me"], { env: { RUNTA_TOKEN: "" } });
  assert.equal(r.code, 3);
  assert.match(r.json().error.message, /RUNTA_TOKEN/);
  assert.equal(api.calls.length, before);
});

test("destructive commands refuse without a terminal unless --yes, and send nothing", async () => {
  const r = await run(["runtimes", "delete", RT_ID]);
  assert.equal(r.code, 8);
  assert.equal(r.json().error.code, "confirmation_required");
  assert.ok(!api.calls.some((c) => c.method === "DELETE"));
  const ok = await run(["runtimes", "delete", RT_ID, "--yes"]);
  assert.equal(ok.code, 0);
  assert.ok(api.calls.some((c) => c.method === "DELETE"));
});

test("--dry-run prints the request and sends nothing", async () => {
  const before = api.calls.filter((c) => c.method === "POST").length;
  const r = await run(["runtimes", "create", "--name", "x", "--image", "codex", "--dry-run"]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json().body, { name: "x", image: { id: "codex" } });
  assert.equal(api.calls.filter((c) => c.method === "POST").length, before);
});

test("invalid input is rejected from the schema before sending (exit 2)", async () => {
  const r = await run(["runtimes", "create", "--resources.requests.vcpus", "0"]);
  assert.equal(r.code, 2);
  assert.deepEqual(r.json().error.details[0], { path: "body.resources.requests.vcpus", message: "must be >= 1" });
});

test("unknown flags and commands suggest the closest match", async () => {
  const f = await run(["runtimes", "list", "--stauts", "running"]);
  assert.equal(f.code, 2);
  assert.match(f.json().error.message, /did you mean --status/);
  const c = await run(["exec", "demo", "--", "ls"]);
  assert.match(c.json().error.message, /runta runtimes exec/);
});

test("creates send an Idempotency-Key so retries are safe", async () => {
  await run(["runtimes", "create", "--name", "idem"]);
  const call = api.calls.findLast((c) => c.method === "POST" && c.path === "/v2/runtimes");
  assert.match(call.headers["idempotency-key"], /^[0-9a-f-]{36}$/);
});

test("expected_revision is filled in from getRuntime and --wait polls until the target state", async () => {
  const r = await run(["runtimes", "pause", "demo", "--wait", "--fields", "data.status"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json(), { data: { status: "paused" } });
  const pause = api.calls.find((c) => c.path.endsWith("/pause"));
  assert.equal(pause.query.expected_revision, "7");
});

test("--wait ending in a failed state exits 9 and prints the final resource", async () => {
  const r = await run(["agents", "create-run", AGENT_ID, "--prompt", "hi", "--wait"]);
  assert.equal(r.code, 9);
  assert.equal(r.json().status, "failed");
  assert.equal(JSON.parse(r.stderr.trim().split("\n").pop()).error.code, "failed_state");
});

test("server-sent events become one JSON object per line", async () => {
  const r = await run(["agents", "stream-events", AGENT_ID, RUN_ID]);
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.data.status), ["running", "finished"]);
  assert.equal(lines[1].event, "run.status");
});

test("exec streams stdout/stderr and exits with the remote exit code", async () => {
  const r = await run(["runtimes", "exec", RT_ID, "--env", "A=1", "--", "echo", "hi there"]);
  assert.equal(r.code, 3);
  assert.equal(r.stdout, "echo hi there\n");
  assert.match(r.stderr, /env=\{"A":"1"\}/);
  const start = api.calls.find((c) => c.ws?.type === "start").ws;
  assert.deepEqual([start.command, start.args, start.tty], ["echo", ["hi there"], false]);
  assert.ok(api.calls.some((c) => c.ws?.type === "close_stdin"));
});

test("exec errors before the session starts go to stderr with exit 255", async () => {
  const r = await run(["runtimes", "exec", RT_ID, "--", "ls"], { env: { RUNTA_TOKEN: "wrong" } });
  assert.equal(r.code, 255);
  assert.equal(r.stdout, "");
  assert.equal(JSON.parse(r.stderr.trim()).error.code, "unauthenticated");
});

test("every invocation is logged locally without credentials", async () => {
  const r = await run(["identity", "get-me", "--token", "test-key"], { env: { RUNTA_TOKEN: "" } });
  const log = readFileSync(join(r.home, "state", "runta-agent-cli", "activity.jsonl"), "utf8");
  const entry = JSON.parse(log.trim().split("\n").pop());
  assert.equal(entry.operation_id, "getMe");
  assert.equal(entry.status, 200);
  assert.ok(entry.request_id);
  assert.ok(!log.includes("test-key"));
});

test("login --with-token verifies the key and stores it for later commands", async () => {
  const r = await run(["login", "--with-token"], { env: { RUNTA_TOKEN: "" }, input: "test-key\n" });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json().user, "dev@example.com");
  const stored = JSON.parse(readFileSync(join(r.home, "config", "runta-agent-cli", "credentials.json"), "utf8"));
  assert.equal(stored.token, "test-key");
});

test("operations without a security requirement need no credential", async () => {
  const healthApi = await fakeApi({ "GET /healthz": (req, res) => { res.writeHead(200); res.end(); } });
  const r = await runCli(["health", "healthz"], { endpoint: healthApi.url, env: { RUNTA_TOKEN: "" } });
  await healthApi.close();
  assert.equal(r.code, 0, r.stdout);
});

test("exec --max-output prints up to the limit, then says it stopped", async () => {
  const r = await run(["runtimes", "exec", RT_ID, "--max-output", "4", "--", "echo", "hello"]);
  assert.equal(r.stdout, "echo");
  assert.match(r.stderr, /output truncated after 4 bytes/);
});

test("--data @- and --data - read the body from stdin; an unreadable file is a usage error", async () => {
  for (const src of ["@-", "-"]) {
    await run(["runtimes", "create", "--data", src], { input: JSON.stringify({ name: `from-stdin${src}` }) });
    const call = api.calls.findLast((c) => c.method === "POST" && c.path === "/v2/runtimes");
    assert.equal(call.body.name, `from-stdin${src}`);
  }
  const bad = await run(["runtimes", "create", "--data", "@/nonexistent/body.json"]);
  assert.equal(bad.code, 2);
  assert.match(bad.json().error.message, /cannot read --data .*ENOENT/);
});

test("unknown commands suggest by common verb synonyms and by related flags", async () => {
  const upload = await run(["files", "upload"]);
  assert.equal(upload.code, 2);
  assert.match(upload.json().error.message, /files write/);
  assert.match((await run(["runtimes", "ls"])).json().error.message, /runtimes list/);
  assert.match((await run(["ps"])).json().error.message, /runta runtimes list/);
  assert.match((await run(["runtimes", "ingress"])).json().error.message, /--ingress-specs/);
});

test("schema suggests a valid command on a typo; spec says where the bundled document is", async () => {
  const s = await run(["schema", "runtimes", "lst"]);
  assert.equal(s.code, 2);
  assert.match(s.stdout + s.stderr, /runtimes list/);
  const spec = await run(["spec"]);
  assert.equal(spec.code, 0);
  const out = spec.json();
  const doc = JSON.parse(readFileSync(out.path, "utf8"));
  const ops = Object.values(doc.paths).flatMap((p) => Object.values(p)).filter((o) => o && o.operationId);
  assert.equal(out.operations, ops.length);
});
