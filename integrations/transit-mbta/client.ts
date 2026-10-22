import { createHash } from "node:crypto";
import type {
  HttpClient,
  SharedRequestPolicy,
  UpstreamRuntime,
} from "@openmapx/integration-framework";
import type { ZodType } from "zod";
import { MbtaError } from "./errors";

const ORIGIN = "https://api-v3.mbta.com";
const TIMEOUT_MS = 8000;
export const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const policy: SharedRequestPolicy = {
  id: "mbta-registered-default",
  limit: 1000,
  durationMs: 60000,
  minIntervalMs: 60,
};
interface Options {
  http: HttpClient;
  upstreamRuntime?: UpstreamRuntime;
  apiKey?: string;
  signal: AbortSignal;
  isSourceAllowed: () => Promise<boolean>;
}
interface Page<R, I> {
  data: R[];
  included?: I[];
  links?: { next?: string | null; last?: string | null };
}
export interface MbtaClient {
  readonly signal: AbortSignal;
  readonly configured: boolean;
  assertAvailable(signal?: AbortSignal): Promise<void>;
  request<T>(path: string, schema: ZodType<T>, signal?: AbortSignal): Promise<T>;
  collect<R extends { type: string; id: string }, I extends { type: string; id: string }>(
    initialUrl: string,
    load: (offset: number, signal: AbortSignal) => Promise<Page<R, I>>,
  ): Promise<{ data: R[]; included: I[] }>;
}
function aborted(signal: AbortSignal): MbtaError {
  return new MbtaError(signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled");
}
/** Own even dependencies that do not cooperate with cancellation; ignore their late success. */
function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(aborted(signal));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        if (signal.aborted) throw aborted(signal);
        return operation();
      })
      .then(
        (value) => {
          signal.removeEventListener("abort", abort);
          if (signal.aborted) reject(aborted(signal));
          else resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
  });
}
async function deadline<T>(
  signals: AbortSignal[],
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new DOMException("Deadline expired", "TimeoutError")),
    TIMEOUT_MS,
  );
  timer.unref?.();
  const signal = AbortSignal.any([...signals, timeout.signal]);
  try {
    return await run(signal);
  } catch (error) {
    if (signal.aborted) throw aborted(signal);
    if (error instanceof MbtaError) throw error;
    throw new MbtaError("unavailable");
  } finally {
    clearTimeout(timer);
  }
}
function requestUrl(path: string): URL {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("#") ||
    /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$|\?)/i.test(path)
  )
    throw new MbtaError("input");
  const url = new URL(path, ORIGIN);
  if (
    url.origin !== ORIGIN ||
    url.username ||
    url.password ||
    !/^\/(?:stops(?:\/[^/]+)?|predictions|vehicles|alerts|facilities)$/.test(url.pathname) ||
    [...url.searchParams.keys()].some((key) => key.toLowerCase() === "api_key")
  )
    throw new MbtaError("input");
  return url;
}
function cooldown(headers: Readonly<Record<string, string>>): number {
  const reset = Number(headers["x-ratelimit-reset"]);
  const now = Date.now();
  const date = Date.parse(headers.date ?? "");
  const reference = Number.isFinite(date) ? date : now;
  const delay = Math.ceil(reset * 1000 - reference);
  return Number.isSafeInteger(delay) && delay > 0 && Number.isSafeInteger(now + delay)
    ? delay
    : 60000;
}
function intent(url: URL): string {
  const params = new URLSearchParams(url.search);
  params.delete("page[offset]");
  params.delete("page[limit]");
  params.sort();
  return `${url.origin}${url.pathname}?${params}`;
}
function pageOffset(link: string, first: URL): number {
  let next: URL;
  try {
    next = new URL(link, ORIGIN);
  } catch {
    throw new MbtaError("payload");
  }
  const offset = next.searchParams.get("page[offset]");
  if (
    next.origin !== ORIGIN ||
    next.username ||
    next.password ||
    next.hash ||
    intent(next) !== intent(first) ||
    next.searchParams.getAll("page[offset]").length !== 1 ||
    next.searchParams.getAll("page[limit]").length !== 1 ||
    next.searchParams.get("page[limit]") !== String(PAGE_SIZE) ||
    !offset ||
    !/^\d+$/.test(offset)
  )
    throw new MbtaError("payload");
  const value = Number(offset);
  if (!Number.isSafeInteger(value) || value % PAGE_SIZE !== 0) throw new MbtaError("payload");
  return value;
}
export function createMbtaClient(options: Options): MbtaClient {
  const key = options.apiKey?.trim() ?? "";
  const configured =
    key.length > 0 &&
    key.length <= 512 &&
    !/\s/.test(key) &&
    [...key].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);
  const shared = options.upstreamRuntime;
  const admitRequest = shared?.admitSharedRequest?.bind(shared);
  const deferRequest = shared?.deferSharedRequests?.bind(shared);
  const identity = { scope: ORIGIN, key: createHash("sha256").update(key).digest("hex") };
  async function available(signal: AbortSignal) {
    if (signal.aborted) throw aborted(signal);
    if (!configured) throw new MbtaError("unconfigured");
    if (!(await bounded(options.isSourceAllowed, signal))) throw new MbtaError("policy");
    if (signal.aborted) throw aborted(signal);
  }
  async function admit(signal: AbortSignal) {
    if (!admitRequest || !deferRequest) throw new MbtaError("unavailable");
    for (;;) {
      await available(signal);
      const decision = await bounded(() => admitRequest({ ...identity, policy, signal }), signal);
      if (decision.allowed) return;
      if (decision.reason !== "spacing")
        throw new MbtaError(decision.reason === "store_unavailable" ? "unavailable" : "quota");
      const wait = decision.retryAfterMs;
      if (wait === null || !Number.isFinite(wait) || wait <= 0) throw new MbtaError("unavailable");
      await bounded(
        () =>
          new Promise<void>((resolve, reject) => {
            const abort = () => {
              clearTimeout(timer);
              signal.removeEventListener("abort", abort);
              reject(aborted(signal));
            };
            const timer = setTimeout(
              () => {
                signal.removeEventListener("abort", abort);
                resolve();
              },
              Math.min(wait, TIMEOUT_MS),
            );
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          }),
        signal,
      );
    }
  }
  const client: MbtaClient = {
    signal: options.signal,
    configured,
    async assertAvailable(signal = options.signal) {
      await deadline([options.signal, signal], available);
    },
    async request(path, schema, callerSignal) {
      return deadline([options.signal, ...(callerSignal ? [callerSignal] : [])], async (signal) => {
        try {
          const url = requestUrl(path);
          await available(signal);
          await admit(signal);
          await available(signal);
          const response = await bounded(
            () =>
              options.http.getResponse<unknown>(url.href, {
                signal,
                headers: {
                  "x-api-key": key,
                  "MBTA-Version": "2021-01-09",
                  Accept: "application/vnd.api+json",
                },
                timeoutMs: TIMEOUT_MS,
                maxBytes: 2 * 1024 * 1024,
                contentTypes: ["application/vnd.api+json"],
                redirect: "error",
                responseHeaders: [
                  "x-ratelimit-limit",
                  "x-ratelimit-remaining",
                  "x-ratelimit-reset",
                  "date",
                ],
              }),
            signal,
          );
          await available(signal);
          if (response.status === 429 || response.headers["x-ratelimit-remaining"] === "0") {
            if (!deferRequest) throw new MbtaError("unavailable");
            await bounded(
              () =>
                deferRequest({
                  ...identity,
                  delayMs: cooldown(response.headers),
                  signal,
                }),
              signal,
            );
            await available(signal);
          }
          if (response.status !== 200)
            throw new MbtaError(
              response.status === 429
                ? "quota"
                : response.status === 403
                  ? "auth"
                  : response.status === 404
                    ? "not_found"
                    : "upstream",
            );
          const parsed = schema.safeParse(response.body);
          if (!parsed.success) throw new MbtaError("payload");
          await available(signal);
          return parsed.data;
        } catch (error) {
          if (signal.aborted) throw aborted(signal);
          if (error instanceof MbtaError) throw error;
          throw new MbtaError("unavailable");
        }
      });
    },
    async collect<R extends { type: string; id: string }, I extends { type: string; id: string }>(
      initialUrl: string,
      load: (offset: number, signal: AbortSignal) => Promise<Page<R, I>>,
    ) {
      return deadline([options.signal], async (signal) => {
        const first = requestUrl(initialUrl);
        const data = new Map<string, R>();
        const included = new Map<string, I>();
        let offset = 0;
        for (let count = 0; count < MAX_PAGES; count++) {
          await available(signal);
          const page = await bounded(() => load(offset, signal), signal);
          await available(signal);
          for (const value of page.data) data.set(`${value.type}:${value.id}`, value);
          for (const value of page.included ?? []) included.set(`${value.type}:${value.id}`, value);
          if (data.size > 5000 || included.size > 20000) throw new MbtaError("payload");
          const next = page.links?.next;
          if (next === undefined || next === null) {
            const last = page.links?.last;
            if (last !== undefined && last !== null && pageOffset(last, first) !== offset)
              throw new MbtaError("payload");
            return { data: [...data.values()], included: [...included.values()] };
          }
          const following = pageOffset(next, first);
          if (following !== offset + PAGE_SIZE) throw new MbtaError("payload");
          offset = following;
        }
        throw new MbtaError("payload");
      });
    },
  };
  return client;
}
