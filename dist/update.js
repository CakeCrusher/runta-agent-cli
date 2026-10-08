// Once a day, ask GitHub for the latest published version. Never blocks or fails a command.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, stateDir } from "./env.js";
import { USER_AGENT, VERSION } from "./http.js";
const SOURCE = "https://raw.githubusercontent.com/CakeCrusher/runta-agent-cli/main/package.json";
export const INSTALL = "npm install -g github:CakeCrusher/runta-agent-cli";
const DAY = 24 * 60 * 60 * 1000;
export const newer = (a, b) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++)
        if ((pa[i] || 0) !== (pb[i] || 0))
            return (pa[i] || 0) > (pb[i] || 0);
    return false;
};
function readState(env) {
    try {
        return JSON.parse(readFileSync(join(stateDir(env), "update.json"), "utf8"));
    }
    catch {
        return {};
    }
}
// Resolves to {latest, current, outdated} or null.
export async function checkForUpdate(env = process.env, { force = false } = {}) {
    if (env.RUNTA_NO_UPDATE_CHECK || (env.CI && !force))
        return null;
    const state = readState(env);
    let latest = state.latest;
    if (force || !state.checked_at || Date.now() - Date.parse(state.checked_at) > DAY) {
        try {
            const res = await fetch(SOURCE, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(2500) });
            if (res.ok)
                latest = (await res.json()).version;
            ensureDir(stateDir(env));
            writeFileSync(join(stateDir(env), "update.json"), JSON.stringify({ checked_at: new Date().toISOString(), latest }) + "\n");
        }
        catch {
            return latest ? { latest, current: VERSION, outdated: newer(latest, VERSION) } : null;
        }
    }
    return latest ? { latest, current: VERSION, outdated: newer(latest, VERSION) } : null;
}
//# sourceMappingURL=update.js.map