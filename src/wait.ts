// Generic waiter for operations that return before the work is done (x-wait in the spec): poll the named
// operation until a success condition holds, a failure condition holds, or time runs out.
import { CliError, exitForStatus } from "./exit.js";
import { evaluateAll, pointer } from "./resolve.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function holds(cond, res) {
  if (cond.status !== undefined) return res.status === cond.status;
  if (res.status >= 400) return false;
  const v = pointer(res.body, cond.pointer);
  if (cond.present) return v !== undefined && v !== null && v !== "";
  if (cond.in) return cond.in.includes(v);
  return false;
}

/**
 * Returns {outcome: "done"|"failed"|"timeout", res, waitedMs}. Transient errors (429/5xx) keep polling;
 * other errors stop the wait with that error.
 */
export async function waitFor(client, spec, ctx, { timeoutSeconds, onState }: { timeoutSeconds?: number; onState?: (state: string, elapsedMs: number) => void } = {}) {
  const params = evaluateAll(spec.parameters, ctx);
  const limitMs = (timeoutSeconds ?? spec.timeoutSeconds ?? 300) * 1000;
  const watched = (spec.until || []).find((c) => c.pointer)?.pointer;
  const started = Date.now();
  let delay = (spec.intervalSeconds ?? 1) * 1000;
  let last;
  let lastState;
  for (;;) {
    const res = await client.call(spec.operationId, params);
    last = res;
    if ((spec.until || []).some((c) => holds(c, res))) return { outcome: "done", res, waitedMs: Date.now() - started };
    if ((spec.fail || []).some((c) => holds(c, res))) return { outcome: "failed", res, waitedMs: Date.now() - started };
    if (res.status >= 400 && res.status !== 429 && res.status < 500) {
      const err = res.body?.error;
      throw new CliError(err?.code || "wait_failed", `while waiting (${spec.operationId}): ${err?.message || `HTTP ${res.status}`}`, exitForStatus(res.status), { request_id: res.requestId });
    }
    const state = watched ? pointer(res.body, watched) : `HTTP ${res.status}`;
    if (state !== lastState) onState?.(state, Date.now() - started);
    lastState = state;
    if (Date.now() - started + delay > limitMs) return { outcome: "timeout", res: last, waitedMs: Date.now() - started };
    await sleep(delay);
    delay = Math.min(delay * 1.5, 5000);
  }
}
