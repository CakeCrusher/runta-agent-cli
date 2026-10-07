#!/usr/bin/env node
// Contract test: call read-only endpoints on the live API and check every response against the bundled
// (edited) spec. If Runta returns something our spec does not allow, this fails, which keeps the
// edited spec honest. Needs RUNTA_TOKEN (or a stored login). Usage: npm run contract
import Ajv from "ajv";
import { resolveToken } from "../src/auth.js";
import { Client } from "../src/client.js";
import { buildCommands, loadSpec } from "../src/spec.js";

const spec = loadSpec();
const groups = buildCommands(spec);
const cred = resolveToken(undefined);
if (!cred) {
  console.error("no API key: set RUNTA_TOKEN");
  process.exit(3);
}
const client = new Client({ spec, groups, endpoint: process.env.RUNTA_ENDPOINT || spec.servers[0].url, token: cred.token });
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema({ $id: "runta", components: spec.components });
const rebase = (n) => (Array.isArray(n) ? n.map(rebase) : n && typeof n === "object" ? Object.fromEntries(Object.entries(n).map(([k, v]) => [k, k === "$ref" && v.startsWith("#/") ? "runta" + v : rebase(v)])) : n);

async function check(operationId, params = {}) {
  const cmd = client.command(operationId);
  const res = await client.call(operationId, params);
  const declared = spec.paths[cmd.path][cmd.method.toLowerCase()].responses[String(res.status)];
  const schema = declared?.content?.["application/json"]?.schema;
  let ok = Boolean(declared);
  let detail = declared ? "" : `status ${res.status} is not declared`;
  if (schema) {
    const v = ajv.compile(rebase(schema));
    ok = v(res.body);
    if (!ok) detail = v.errors.slice(0, 3).map((e) => `${e.instancePath || "/"} ${e.message}${e.params?.allowedValues ? " " + JSON.stringify(e.params.allowedValues) : ""}`).join("; ");
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${operationId.padEnd(32)} HTTP ${res.status}${detail ? "  " + detail : ""}`);
  return { ok, body: res.body };
}

const results = [];
results.push(await check("healthz"));
results.push(await check("getMe"));
const runtimes = await check("listRuntimes", { limit: 100 });
results.push(runtimes);
for (const r of (runtimes.body?.data || []).slice(0, 5)) results.push(await check("getRuntime", { runtime_id: r.id }));
results.push(await check("listCheckpoints"));
const agents = await check("listCloudAgents");
results.push(agents);
for (const a of (agents.body?.agents || []).slice(0, 3)) {
  results.push(await check("getCloudAgent", { agent_id: a.id }));
  const runs = await check("listCloudAgentRuns", { agent_id: a.id });
  results.push(runs);
}
results.push(await check("listManagedModelProviders"));
results.push(await check("listRuntimeImages"));
results.push(await check("listSshKeys"));
results.push(await check("listSecrets"));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} responses match the edited spec`);
process.exit(failed ? 1 : 0);
