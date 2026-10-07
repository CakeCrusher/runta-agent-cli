# Changes to Runta's OpenAPI spec

`spec/runta-openapi.yaml` is a one-time edit of Runta's published spec (`spec/runta-openapi.original.yaml`,
fetched from https://runta.com/openapi.yaml on 2026-10-06). The edit changes documentation and adds `x-`
extensions only: no paths removed, no types changed. `npm run contract` validates live API responses against
it (16/16 passed on 2026-10-06). `diff spec/runta-openapi.original.yaml spec/runta-openapi.yaml` shows every
change.

| Change | Why (evidence) |
|---|---|
| `info.description`: what Runta is for, what it is not (not a production web host), costs, identifiers, errors | Agents used Runta as a web host: the operator's own agent, and baseline tasks 3/3b, where neither Codex nor Cursor declined "host my app 24/7" |
| `runtime_id` parameters: "UUID or display name" → "UUID; display names are rejected (422)" | `GET /v2/runtimes/<display name>` returns 422 "runtime_id must be a UUID" |
| `PublicRuntimeStatus`: meaning and next action per value (`x-enum-descriptions`) | The bare 409 on paused runtimes; resume vs. start was unclear (the official CLI suggests `resume` for shut-down runtimes) |
| `PublicErrorCode`: meaning and next action per code | Errors carry a code but nothing says what to do |
| `CloudAgentRun.status`: enum `queued, running, cancelling, finished, failed, cancelled` with meanings | Values exist only in Runta's prose docs; observed queued/running/finished/failed in a live probe |
| `CloudAgent.status`: observed values | pending → running in 36–38 s, shutdown (live probe) |
| `createRuntime`, `resumeRuntime`, `deleteRuntime`, `createCheckpoint`, `createCloudAgent`, `createCloudAgentRun`, `getCloudAgentRun`, `followUpCloudAgentRun`, `streamCloudAgentRunEvents`, `deleteCloudAgent`: descriptions written for agents | Each states when the work is really done, what it costs, and the traps seen in probes (bad provider key fails runs after ~1 s; files written by an agent are not visible via artifacts or the workspace API; `delete_runtime=true` or the runtime keeps running) |
| `components/responses/Conflict`: what a 409 means here | Bare 409 on exec against a paused runtime |
| New path `GET /v2/runtimes/{runtime_id}/exec/stream` (`execRuntime`) with `x-websocket` message schemas | The official CLI's `runta exec` uses this WebSocket, the only endpoint it calls that the spec omits. Protocol observed live (start/stdin/close_stdin/signal; stdout/stderr/exit/error/heartbeat; disconnect kills the command) |

## Extensions the CLI reads

| Extension | Where | Meaning |
|---|---|---|
| `x-wait` | operation | The operation returns before the work is done. Poll `operationId` with `parameters` (OpenAPI runtime expressions) until a condition in `until` holds; `fail` conditions end it early; `timeoutSeconds` is the default. Conditions: `{pointer, in}`, `{pointer, present}`, `{status}` |
| `x-default-from` | parameter | How to obtain the value when the caller doesn't have it (e.g. `expected_revision` from `getRuntime` → `/data/revision`) |
| `x-name-lookups` | root | For a parameter or body field name (`runtime_id`, `agent_id`, `checkpoint_id`): which list operation and field turn a name into the UUID |
| `x-destructive` | operation | Irreversible; defaults to true for DELETE |
| `x-enum-descriptions` | schema with `enum` | Meaning and next action per value |
| `x-websocket` | operation | Message schemas, plus `session`: which message starts it, which carry stdout/stderr, which ends it |

## Asks for Runta (not fixable in a spec copy)

Return a typed 409 body on exec (the CLI already gets one; the official CLI drops it); add a provider
validation endpoint (a bad key surfaces only as a failed run); expose a "ready for exec" state; reject
impossible resource requests (`vcpus: 999` is accepted, then sits in `creating`); let listing runs of a
shut-down agent work (`listCloudAgentRuns` returns 409); accept names or document lookups; publish
`exec/stream` and a feedback endpoint.
