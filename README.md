# runta-agent-cli

An agent-native CLI for the [Runta](https://runta.com) API, built for Runta's take-home ("Build an
Agent-Native CLI"). Unofficial; it talks to the public REST API directly and does not wrap the official CLI.

```sh
npm install -g altrunta     # installs the `runta` and `altrunta` commands (Node 18.17+)
export RUNTA_TOKEN=...      # or: runta login
runta --help                # what Runta is for, then every command group
```

Published on npm as [`altrunta`](https://www.npmjs.com/package/altrunta). Installing from GitHub also works
(`npm install -g github:CakeCrusher/runta-agent-cli`): the compiled `dist/` is committed, so nothing is built on install.

Both commands are the same program. If Runta's official CLI is installed too, its `runta` and this one compete
for the name: whichever comes first on your `PATH` wins, and npm refuses to overwrite a `runta` installed by
another npm package unless you pass `--force`. Use `altrunta` to call this CLI unambiguously.

## The idea: fix the spec, generate the CLI

Almost everything an agent needs to use an API well (what it is for, what a status means, what to do after an
error, when an operation is really done) is knowledge about the API, so it belongs in the API's spec, not in
hand-written CLI code. This CLI therefore has three layers:

1. **Runta's OpenAPI spec, as published** (`spec/runta-openapi.original.yaml`). Every operation becomes a
   command at runtime: `runta <group> <command>`, path parameters positional, query parameters and body fields
   as `--flags`. No per-endpoint code, so all 82 published operations are covered (83 with the exec WebSocket), including Cloud Agents (none of which
   the official CLI exposes).
2. **An improved copy of that spec** (`spec/runta-openapi.yaml`): a one-time, documentation-only edit of a few
   operations on the core paths, plus `x-` extensions the CLI reads. It is the proposal to Runta. Every change
   and its evidence is in [SPEC-CHANGES.md](SPEC-CHANGES.md), and `npm run contract` checks live responses
   against it.
3. **One generic runtime** (`src/`, TypeScript) that applies the same behavior to every command: exit codes, schema
   validation, waiting, confirmation, name lookups, streaming, auth, an activity log, a version check.

`RUNTA_SPEC=original runta ...` runs the same CLI on the unedited spec, which isolates what the spec changes
are worth in an eval.

## For agents

- **stdout is the API's JSON**, unchanged (`--fields data.id,data.status` to narrow it); progress and notices
  go to stderr. Errors, including the CLI's own, use the API's shape: `{"error": {"code", "message"}, "request_id"}`.
- **Exit codes** say what happened: 0 ok, 2 bad input (nothing sent), 3 auth, 4 not found, 5 wrong state
  (e.g. paused runtime), 6 unavailable, 7 `--wait` timed out, 8 refused destructive command, 9 resource ended
  in a failed state. `runtimes exec` returns the remote command's exit code (124 timeout, 255 no session).
- **Names work where IDs are expected** (`runta runtimes exec my-runtime -- ls`), because the spec says how to
  look them up.
- **`--wait`** on commands that return before the work is done (create, resume, runs, checkpoints, deletes).
- **Destructive commands refuse to run without a terminal** unless `--yes` is given, and say what they would
  have sent. `--dry-run` prints any request without sending it.
- **Input is checked against the spec** before anything is sent (`--resources.requests.vcpus 0` fails locally).
  `--data '<json>'`, `--data @file` or `--data @-` (stdin) sends a whole body; flags override its fields.
- **Help is complete, so the spec is never needed**: `runta <group> <command> --help` shows every flag's full
  description and the fields inside nested bodies. Body fields are `--kebab-case` flags; a field inside one takes a
  dot and its exact JSON name (`--image.model_provider_protocol openai_responses`); a list of objects is given as
  JSON. A wrong nested name is refused with the exact one, before anything is sent.
- **Mistyped commands get a suggestion**, by spelling, by common verbs (`upload` → `write`, `ls` → `list`, `rm` →
  `delete`, and the official CLI's `ps`, `run`, `exec`), or by the flags that do the job (`runtimes ingress` →
  `runtimes create --ingress-specs`).
- `runta guide` explains Runta's purpose, the main workflows, conventions and every exit and error code;
  `runta <group> <command> --help` shows what each response status means; `runta schema ...` gives the JSON.

```sh
runta runtimes create --name scratch --wait --fields data.id,data.status
runta runtimes exec scratch -- python3 -c 'print(42)'
runta checkpoints create scratch --name golden --wait
runta runtimes create --name copy-1 --checkpoint-id golden --wait
runta runtimes delete copy-1 --yes --wait
runta agents create --name fix-tests --model-provider.type managed --model-provider.id <id> --wait
runta agents create-run fix-tests --prompt "Fix the failing test and summarize the change" --wait
```

## Credentials

`--token`, then `RUNTA_TOKEN`, then a stored login (OS keychain on macOS, `secret-tool` on Linux, else a 0600
file), then the official CLI's `~/.config/runta/config.toml`. `runta login` uses the API's device-code flow;
agents use `runta login --no-wait` (prints the link and code for the user) and then `runta login --resume`.
`runta login --with-token` stores a key read from stdin. Inside a Runta runtime, `RUNTA_TOKEN` can be a secret
stub: the VM sees a placeholder and Runta injects the real key on egress.

## Utilities

`guide`, `schema` (a command's help as JSON), `api <METHOD> <path>` (any endpoint), `login`, `logout`, `doctor`, `activity` (the local log
of every call, with request IDs), `feedback "<message>"` (saves a bundle with recent activity; Runta has no
feedback endpoint yet).

## Development

```sh
npm install
npm run build         # tsc: src/*.ts -> dist/*.js (commit dist/ with the change; npm run check:dist verifies)
npm test              # builds, then 32 tests against a fake API (HTTP + exec WebSocket)
npm run contract      # live, read-only: responses vs. the edited spec (needs RUNTA_TOKEN)
npm run build:spec    # YAML -> the JSON the CLI loads
```

The code is TypeScript in `src/`, compiled to plain Node in `dist/`; the command tree is still built from the
bundled spec at run time. Tag `v0.1.3` is the JavaScript version benchmarked in Round 3; the TypeScript
refactor compiles to the same program (checked by reprinting both without comments and comparing) and is
published as `altrunta@0.1.3`.

Not yet done: keychain storage on Windows, pagination helpers (`--all`), exec with a TTY.
