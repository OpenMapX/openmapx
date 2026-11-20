const IMF_FIXDATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/** An IMF-fixdate as epoch milliseconds, or null. */
function httpDate(text: string): number | null {
  if (!IMF_FIXDATE.test(text)) return null;
  const at = Date.parse(text);
  // The round trip refuses normalised calendar dates (31 Sep) and wrong day or month names.
  return Number.isFinite(at) && new Date(at).toUTCString() === text ? at : null;
}

export interface RetryAfterOptions {
  /** Clock reading for an HTTP-date value; defaults to `Date.now()`. */
  now?: number;
  /**
   * The response's `Date` header. An HTTP-date value is measured from it when
   * it is a valid date, so a skewed local clock does not stretch the wait.
   */
  serverDate?: string | null;
}

/**
 * The wait a `Retry-After` value asks for, in milliseconds: integer
 * delta-seconds or an IMF-fixdate, with a date already past meaning no wait.
 * Anything else, including negative or fractional seconds, is null. Callers
 * apply their own ceiling and fallback.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  options: RetryAfterOptions = {},
): number | null {
  const text = value?.trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const delay = Number(text) * 1000;
    return Number.isSafeInteger(delay) ? delay : null;
  }
  const at = httpDate(text);
  if (at === null) return null;
  const server = options.serverDate ? httpDate(options.serverDate.trim()) : null;
  return Math.max(0, at - (server ?? options.now ?? Date.now()));
}
