import type { DocumentTypeDecoration } from "@graphql-typed-document-node/core";
import type {
  HttpClient,
  ResponseOptions,
  SharedRequestIdentity,
  SharedRequestPolicy,
  UpstreamRuntime,
} from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  decodeGraphQlEnvelope,
  encodeGraphQlRequest,
} from "@openmapx/mobility-formats/entur/graphql.js";
import { PlanTripDocument } from "@openmapx/mobility-formats/entur/journey-planner.generated.js";
import { EnturRequestError, isEnturRequestError } from "./errors";

export type EnturFamily = "journeyPlanner" | "vehicles" | "nsr" | "geocoder";
export interface EnturConfig {
  clientName?: string;
  journeyPlannerEndpoint?: string;
  vehiclesEndpoint?: string;
  nsrEndpoint?: string;
  geocoderEndpoint?: string;
}
export interface EnturClientOptions {
  http: HttpClient;
  upstreamRuntime?: UpstreamRuntime;
  config: EnturConfig;
  sourceIds: Partial<Record<EnturFamily, string>>;
  contributors: Readonly<Record<string, readonly Attribution[]>>;
  isSourceAllowed: (sourceId: string) => Promise<boolean>;
}
export type DeepReadonly<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;
export interface EnturClient {
  readonly config: Readonly<Required<EnturConfig>>;
  readonly identity: string;
  readonly contributors: DeepReadonly<EnturClientOptions["contributors"]>;
  graphQl<TResult, TVariables>(
    family: "journeyPlanner" | "vehicles",
    document: DocumentTypeDecoration<TResult, TVariables> & { toString(): string },
    variables: NoInfer<TVariables>,
    signal: AbortSignal,
  ): Promise<TResult>;
  getJson<T>(family: "nsr" | "geocoder", pathAndQuery: string, signal: AbortSignal): Promise<T>;
  assertSourceAllowed(family: EnturFamily): Promise<void>;
}
const DEFAULTS: Required<EnturConfig> = {
  clientName: "openmapx-server",
  journeyPlannerEndpoint: "https://api.entur.io/journey-planner/v3/graphql",
  vehiclesEndpoint: "https://api.entur.io/realtime/v2/vehicles/graphql",
  nsrEndpoint: "https://api.entur.io/stop-places/v1/read",
  geocoderEndpoint: "https://api.entur.io/geocoder/v1",
};
// Explicit non-shared observation bound; shared provider delays retain their safe full duration.
const MAX_LOCAL_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 8000;
const MAX_BYTES = 8 * 1024 * 1024;
const endpointKeys = {
  journeyPlanner: "journeyPlannerEndpoint",
  vehicles: "vehiclesEndpoint",
  nsr: "nsrEndpoint",
  geocoder: "geocoderEndpoint",
} as const;

function freeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function normalize(input: EnturConfig): Readonly<Required<EnturConfig>> {
  const config = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof EnturConfig)[]) {
    const value = input[key];
    if (value !== undefined && typeof value !== "string") throw new EnturRequestError("config");
    config[key] = value?.trim() || DEFAULTS[key];
    if (key === "clientName") {
      if (config[key].length > 200 || !/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(config[key]))
        throw new EnturRequestError("config");
    } else {
      let url: URL;
      try {
        url = new URL(config[key]);
      } catch {
        throw new EnturRequestError("config");
      }
      if (url.protocol !== "https:" || url.username || url.password || config[key].includes("#"))
        throw new EnturRequestError("config");
      if (key === "nsrEndpoint" || key === "geocoderEndpoint")
        url.pathname = url.pathname.replace(/\/+$/, "");
      config[key] = url.toString();
    }
  }
  return Object.freeze(config);
}

/** Abort-aware ownership of any async dependency, including a stalled admission/policy store. */
function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(signal.reason);
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
function wait(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delay);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      signal.removeEventListener("abort", abort);
      abort();
    }
  });
}
function cooldownDelay(headers: Readonly<Record<string, string>>, now: number): number {
  const date = Date.parse(headers.date ?? "");
  const reference = Number.isFinite(date) ? date : now;
  const retry = headers["retry-after"]?.trim() ?? "";
  const numericRetry = /^\d+$/.test(retry);
  const retryDelay = numericRetry ? Number(retry) * 1000 : Date.parse(retry) - reference;
  const expiry = headers["rate-limit-expiry-time"]?.trim() ?? "";
  const numeric = /^\d+(?:\.\d+)?$/.test(expiry) ? Number(expiry) : NaN;
  const expiryDelay = Number.isFinite(numeric)
    ? (numeric < 1e12 ? numeric * 1000 : numeric) - reference
    : Date.parse(expiry) - reference;
  const safeDelays = [retryDelay, expiryDelay]
    .map(Math.ceil)
    .filter(
      (delay) => Number.isSafeInteger(delay) && delay > 0 && Number.isSafeInteger(now + delay),
    );
  return Math.max(0, ...safeDelays);
}

/** No singleton or generation lifetime: each call is owned by its explicit caller/shared-fill signal. */
export function createEnturClient(options: EnturClientOptions): EnturClient {
  const config = normalize(options.config);
  const sourceIds = Object.freeze({ ...options.sourceIds });
  const contributors = freeze(structuredClone(options.contributors));
  const identity = canonical({ config, sourceIds, contributors });
  const { http, upstreamRuntime: runtime, isSourceAllowed } = options;
  const cooldowns = new Map<EnturFamily, number>(); // At most the four declared API families.
  const endpoint = (family: EnturFamily) => config[endpointKeys[family]];
  const sharedIdentity = (family: EnturFamily): SharedRequestIdentity => ({
    scope: "entur",
    key: canonical([new URL(endpoint(family)).origin, config.clientName, family]),
  });
  const assertSourceAllowed = async (family: EnturFamily): Promise<void> => {
    const sourceId = sourceIds[family];
    if (!sourceId) throw new EnturRequestError("source");
    let allowed: boolean;
    try {
      allowed = await isSourceAllowed(sourceId);
    } catch {
      throw new EnturRequestError("unavailable");
    }
    if (!allowed) throw new EnturRequestError("policy");
  };
  const admit = async (
    family: EnturFamily,
    policy: SharedRequestPolicy | undefined,
    signal: AbortSignal,
  ) => {
    if (
      family === "journeyPlanner" &&
      (!runtime?.admitSharedRequest || !runtime.deferSharedRequests)
    )
      throw new EnturRequestError("unavailable");
    if (Date.now() < (cooldowns.get(family) ?? 0)) throw new EnturRequestError("cooldown");
    if (!runtime) return;
    if (!runtime.admitSharedRequest || !runtime.deferSharedRequests)
      throw new EnturRequestError("unavailable");
    for (;;) {
      const decision = await bounded(
        runtime.admitSharedRequest({ ...sharedIdentity(family), policy, signal }),
        signal,
      );
      if (decision.allowed) return;
      if (decision.reason !== "spacing")
        throw new EnturRequestError(
          decision.reason === "store_unavailable" ? "unavailable" : decision.reason,
        );
      if (
        !Number.isFinite(decision.retryAfterMs) ||
        decision.retryAfterMs === null ||
        decision.retryAfterMs <= 0
      )
        throw new EnturRequestError("unavailable");
      await wait(Math.min(TIMEOUT_MS, decision.retryAfterMs), signal);
    }
  };
  const execute = async <T>(
    family: EnturFamily,
    url: string,
    body: string | undefined,
    callerSignal: AbortSignal,
    decode: (text: string) => T,
    policy?: SharedRequestPolicy,
  ): Promise<T> => {
    const timeout = new AbortController();
    const signal = AbortSignal.any([callerSignal, timeout.signal]);
    const deadline = Date.now() + TIMEOUT_MS;
    const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
    try {
      signal.throwIfAborted();
      await bounded(assertSourceAllowed(family), signal);
      await admit(family, policy, signal);
      // Admission may have waited while an administrator changed source policy.
      await bounded(assertSourceAllowed(family), signal);
      signal.throwIfAborted();
      const requestOptions: ResponseOptions = {
        headers: {
          "ET-Client-Name": config.clientName,
          "Content-Type": "application/json",
          Accept: "application/json, application/graphql-response+json",
        },
        signal,
        timeoutMs: Math.max(1, deadline - Date.now()),
        maxBytes: MAX_BYTES,
        contentTypes: ["application/json", "application/graphql-response+json"],
        redirect: "error",
        responseHeaders: ["Date", "Retry-After", "Rate-Limit-Expiry-Time"],
      };
      const response = await bounded(
        body === undefined
          ? http.getText(url, requestOptions)
          : http.postText(url, body, requestOptions),
        signal,
      );
      if (response.status < 200 || response.status >= 300) {
        if (response.status === 429) {
          const delayMs = cooldownDelay(response.headers, Date.now());
          if (delayMs > 0) {
            cooldowns.set(
              family,
              Math.max(
                cooldowns.get(family) ?? 0,
                Date.now() + Math.min(MAX_LOCAL_COOLDOWN_MS, delayMs),
              ),
            );
            if (runtime?.deferSharedRequests)
              await bounded(
                runtime.deferSharedRequests({ ...sharedIdentity(family), delayMs, signal }),
                signal,
              );
          }
        }
        throw new EnturRequestError("http", response.status);
      }
      const result = decode(response.body);
      await bounded(assertSourceAllowed(family), signal);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      if (callerSignal.aborted)
        throw new EnturRequestError("abort", undefined, { cause: callerSignal.reason });
      if (timeout.signal.aborted) throw new EnturRequestError("timeout");
      if (isEnturRequestError(error)) throw error;
      throw new EnturRequestError("unavailable");
    } finally {
      clearTimeout(timer);
    }
  };
  return Object.freeze({
    config,
    identity,
    contributors,
    assertSourceAllowed,
    async graphQl<TResult, TVariables>(
      family: "journeyPlanner" | "vehicles",
      document: DocumentTypeDecoration<TResult, TVariables> & { toString(): string },
      variables: NoInfer<TVariables>,
      signal: AbortSignal,
    ): Promise<TResult> {
      let body: string;
      try {
        body = encodeGraphQlRequest(document, variables);
      } catch {
        throw new EnturRequestError("config");
      }
      const trip = document.toString() === PlanTripDocument.toString();
      const policy =
        family === "journeyPlanner"
          ? {
              id: trip ? "trip" : "other",
              limit: trip ? 500 : 1000,
              durationMs: 60000,
              minIntervalMs: trip ? 7 : 5,
            }
          : undefined;
      return execute(
        family,
        endpoint(family),
        body,
        signal,
        (text) => {
          try {
            return decodeGraphQlEnvelope<TResult>(text);
          } catch {
            throw new EnturRequestError("graphql");
          }
        },
        policy,
      );
    },
    async getJson<T>(
      family: "nsr" | "geocoder",
      pathAndQuery: string,
      signal: AbortSignal,
    ): Promise<T> {
      const base = new URL(endpoint(family));
      let url: URL;
      try {
        url = new URL(`${base.origin}${base.pathname.replace(/\/$/, "")}${pathAndQuery}`);
      } catch {
        throw new EnturRequestError("config");
      }
      if (
        !pathAndQuery.startsWith("/") ||
        pathAndQuery.startsWith("//") ||
        pathAndQuery.includes("\\") ||
        pathAndQuery.includes("#") ||
        url.hash ||
        url.origin !== base.origin ||
        !url.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/`)
      )
        throw new EnturRequestError("config");
      for (const [key, value] of base.searchParams) {
        if (!url.searchParams.has(key)) url.searchParams.append(key, value);
      }
      return execute(family, url.toString(), undefined, signal, (text) => {
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new EnturRequestError("response");
        }
      });
    },
  });
}
