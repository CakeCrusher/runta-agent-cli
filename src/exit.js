// Exit codes are the one signal every caller gets, so each outcome class has its own.
export const EXIT = {
  ok: 0,
  apiError: 1, // any other API error
  usage: 2, // bad flags or input; nothing was sent (or the API rejected the input: 400/422)
  auth: 3, // no credential, 401, 403
  notFound: 4, // 404
  conflict: 5, // 409/412: wrong state, retry after fixing it
  unavailable: 6, // 429/5xx after retries
  timeout: 7, // --wait ran out; the operation may still finish (exec uses 124, like timeout(1))
  confirm: 8, // destructive command refused without --yes
  failedState: 9, // --wait saw the resource end in a failed state (e.g. run failed)
};

export function exitForStatus(status) {
  if (status >= 200 && status < 400) return EXIT.ok;
  if (status === 400 || status === 422) return EXIT.usage;
  if (status === 401 || status === 403) return EXIT.auth;
  if (status === 404) return EXIT.notFound;
  if (status === 409 || status === 412) return EXIT.conflict;
  if (status === 429 || status >= 500) return EXIT.unavailable;
  return EXIT.apiError;
}

// Errors raised by the CLI itself use the API's own error shape, so callers parse one format.
export class CliError extends Error {
  constructor(code, message, exitCode, extra = {}) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.extra = extra;
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, ...this.extra } };
  }
}

export const usageError = (message, extra) => new CliError("invalid_argument", message, EXIT.usage, extra);
