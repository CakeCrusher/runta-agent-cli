// Calls any operation by operationId. Commands, lookups and waits all go through here.
import { commandByOperationId } from "./spec.js";
import { buildUrl, request } from "./http.js";
import { CliError, EXIT } from "./exit.js";

export class Client {
  constructor({ spec, groups, endpoint, token }) {
    Object.assign(this, { spec, groups, endpoint, token });
  }

  command(operationId) {
    const cmd = commandByOperationId(this.groups, operationId);
    if (!cmd) throw new CliError("internal", `the spec references unknown operation ${operationId}`, EXIT.apiError);
    return cmd;
  }

  // Splits a flat {name: value} map into path/query/header values using the operation's parameters.
  place(cmd, values) {
    const out = { path: {}, query: {}, headers: {} };
    for (const [name, value] of Object.entries(values)) {
      const p = cmd.params.find((x) => x.name === name);
      if (!p || p.in === "query") out.query[name] = value;
      else if (p.in === "path") out.path[name] = value;
      else if (p.in === "header") out.headers[name] = value;
    }
    return out;
  }

  url(cmd, path = {}, query = {}) {
    const filled = cmd.path.replace(/\{([^}]+)\}/g, (_, name) => {
      if (path[name] === undefined) throw new CliError("invalid_argument", `missing path parameter ${name}`, EXIT.usage);
      return encodeURIComponent(String(path[name]));
    });
    return buildUrl(this.endpoint, filled, query);
  }

  async call(operationId, values = {}, { body, stream } = {}) {
    const cmd = this.command(operationId);
    const { path, query, headers } = this.place(cmd, values);
    return request({
      method: cmd.method,
      url: this.url(cmd, path, query),
      token: cmd.noAuth ? undefined : this.token,
      headers,
      body,
      contentType: cmd.body?.contentType,
      stream,
    });
  }
}
