import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCommands, findGroup, loadSpec } from "../dist/spec.js";
import { topHelp } from "../dist/help.js";
import { parseArgs } from "../dist/args.js";
import { project } from "../dist/output.js";
import { redactArgv } from "../dist/activity.js";

const spec = loadSpec({});
const groups = buildCommands(spec);
const names = (g) => [...findGroup(groups, g).commands.keys()];

test("every operation in the spec becomes exactly one command", () => {
  const ops = Object.values(spec.paths).flatMap((item) => Object.keys(item).filter((m) => ["get", "post", "put", "patch", "delete", "head"].includes(m)));
  const cmds = [...groups.values()].reduce((n, g) => n + g.commands.size, 0);
  assert.equal(cmds, ops.length);
});

test("command names drop the group's own words and stay unique", () => {
  assert.ok(names("runtimes").includes("create"));
  assert.ok(names("runtimes").includes("exec"));
  assert.ok(names("cloud-agents").includes("create-run"));
  assert.ok(names("files").includes("read"));
  assert.deepEqual(names("ssh-keys").filter((n) => n.startsWith("list")), ["list", "list-runtime"]);
  assert.ok(names("github").includes("list-repositories"));
  assert.equal(findGroup(groups, "agents").name, "cloud-agents");
});

test("top-level help leads with what Runta is for and is small", () => {
  const help = topHelp(spec, groups);
  assert.match(help, /Runta is not a production web host/);
  assert.match(help, /runta cloud-agents create-run/);
  assert.ok(help.length < 6000, `help is ${help.length} chars`);
});

test("the original spec yields the same commands without the meaning layer", () => {
  const original = loadSpec({ RUNTA_SPEC: "original" });
  const og = buildCommands(original);
  assert.ok(findGroup(og, "runtimes").commands.has("create"));
  assert.ok(!findGroup(og, "runtimes").commands.has("exec"));
  assert.doesNotMatch(topHelp(original, og), /production web host/);
});

test("flags: dotted nesting, one-field object shorthand, repeated KEY=VALUE maps", () => {
  const cmd = findGroup(groups, "runtimes").commands.get("create");
  const a = parseArgs(spec, cmd, ["--image", "codex", "--resources.requests.vcpus", "2", "--environment-variables", "A=1", "--environment-variables", "B=2"]);
  assert.deepEqual(a.values.get("image"), { id: "codex" });
  assert.deepEqual(a.values.get("environment_variables"), { A: "1", B: "2" });
  assert.deepEqual(a.nested[0].slice(0, 2), [["resources", "requests", "vcpus"], "2"]);
});

test("project and redact", () => {
  assert.deepEqual(project({ data: [{ a: 1, b: 2 }], x: 1 }, ["data.a"]), { data: [{ a: 1 }] });
  assert.deepEqual(redactArgv(["secrets", "create", "--value", "s3cret", "--token=abc", "--", "echo", "pw"]), ["secrets", "create", "--value", "<redacted>", "--token=<redacted>", "--", "<2 args redacted>"]);
});
