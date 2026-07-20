/**
 * Shared HTTP-probe helpers for the MOTIS staging/primary smoke checks. Both
 * motis-health and promote used to carry byte-identical copies of these; the
 * duplication cost a hand-applied endpoint rename in lockstep, so they now live
 * here.
 */

export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/** Parse a positive-integer env var (milliseconds), falling back when unset/invalid. */
export function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export interface ProbeFailure {
  probe: string;
  reason: string;
  /**
   * True when the probe never reached the server (connection refused, DNS,
   * timeout) — i.e. retryable while the server is still starting. False/absent
   * when the server responded but the response itself was bad (HTTP error,
   * non-JSON body), which is a terminal failure that should not be retried.
   */
  transient?: boolean;
}

// Transient undici/socket faults worth a quick retry. When MOTIS closes a
// keep-alive connection the pool tried to reuse (common while it is restarting
// or under load during a sync), `fetch` rejects with "terminated" (and the
// parser may also throw an ERR_ASSERTION swallowed in index.ts). A deliberate
// timeout abort ("aborted") is NOT in this set — we don't retry those.
const TRANSIENT_FETCH_ERROR =
  /terminated|ECONNRESET|socket hang up|other side closed|UND_ERR|EPIPE|ECONNREFUSED/i;

function isTransientFetchError(error: unknown): boolean {
  const message = (error as { message?: unknown })?.message;
  const cause = (error as { cause?: unknown })?.cause;
  return (
    TRANSIENT_FETCH_ERROR.test(String(message ?? "")) ||
    TRANSIENT_FETCH_ERROR.test(String((cause as { message?: unknown })?.message ?? cause ?? ""))
  );
}

/**
 * Fetch with an abort-timeout, retrying only transient socket faults (idempotent
 * GET probes/polls). Each attempt gets a fresh timeout; a deliberate timeout
 * abort is not retried.
 */
export async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  retries = 2,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { signal: ctrl.signal });
    } catch (error) {
      lastError = error;
      if (attempt === retries || !isTransientFetchError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

/**
 * Single probe: 200 + JSON body → null (pass). A non-2xx or non-JSON response
 * is a terminal failure (`transient` unset); a thrown fetch (connection
 * refused, abort/timeout) is transient.
 */
export async function probe(
  name: string,
  url: string,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<ProbeFailure | null> {
  try {
    const res = await fetchWithTimeout(url, timeoutMs);
    if (!res.ok) {
      return { probe: name, reason: `HTTP ${res.status}` };
    }
    // Validate the response is JSON so we catch HTML error pages from a reverse
    // proxy that still returns 200.
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.toLowerCase().includes("json")) {
      return { probe: name, reason: `unexpected content-type ${ct || "(none)"}` };
    }
    await res.json();
    return null;
  } catch (error) {
    return { probe: name, reason: (error as Error).message, transient: true };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === "function") t.unref();
  });
}

/**
 * Poll `url` until it answers 200 + JSON (returns null) or `deadline` passes.
 *
 * Unlike a single {@link probe}, this is a *liveness* poll, so it retries EVERY
 * non-200 — a refused connection (server not bound yet) AND an HTTP/content-type
 * error — until the server is ready. MOTIS's `/api/v1/health` in particular
 * returns HTTP 400 while the timetable is still importing and only flips to 200
 * once it can serve, so a poll that bailed on the first 400 would never see a
 * healthy staging during a real (multi-minute) import. Each attempt's timeout is
 * clamped to the remaining budget so the loop stays bounded by `deadline`.
 */
export async function pollUntilHealthy(
  url: string,
  deadline: number,
  opts: { name?: string; intervalMs?: number; probeTimeoutMs?: number } = {},
): Promise<ProbeFailure | null> {
  const name = opts.name ?? "health";
  const interval = opts.intervalMs ?? 1_000;
  const probeTimeout = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  let last: ProbeFailure | null = null;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    last = await probe(name, url, Math.min(probeTimeout, remaining));
    if (!last) return null;
    const sleep = Math.min(interval, deadline - Date.now());
    if (sleep <= 0) break;
    await delay(sleep);
  }
  return last ?? { probe: name, reason: "did not become healthy within budget" };
}
