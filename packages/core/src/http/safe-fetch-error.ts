// Kept apart from safe-download so code that only classifies the error does not
// load the pinned fetch transport and its HTTP client.

/** Safe metadata for non-success HTTP responses; deliberately excludes their body and request headers. */
export class SafeFetchHttpError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;
  readonly finalUrl: string;

  constructor(status: number, finalUrl: string, retryAfterSeconds: number | null) {
    super(`Request failed: HTTP ${status} for ${finalUrl}`);
    this.name = "SafeFetchHttpError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.finalUrl = finalUrl;
  }
}
