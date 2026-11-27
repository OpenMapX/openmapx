// Kept apart from fetchJson so code that only classifies the error can import it
// through a subpath that does not also expose fetchJson past the provider HTTP
// policy, which recognises fetchJson by its import specifier.

/** Structured non-2xx response so callers can distinguish a missing resource from throttling. */
export class FetchJsonHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = "FetchJsonHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}
