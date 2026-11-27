import { AsyncLocalStorage } from "node:async_hooks";
import {
  type Logger,
  PROVIDER_SHAPES,
  type ProviderDomain,
  ProviderTimeoutError,
} from "@openmapx/integration-framework";

/**
 * The integration whose code is running. Host code enters it wherever it calls
 * into an integration, so log lines, late registrations and slow calls can be
 * attributed to the integration that caused them.
 */
export interface IntegrationScope {
  readonly integrationId: string;
  readonly isBuiltIn: boolean;
  /** Set once the integration was left out or its generation retired. */
  revoked: boolean;
}

const storage = new AsyncLocalStorage<IntegrationScope>();

/** Runs `fn` with `scope` as the current integration, including the work it schedules. */
export function runInIntegrationScope<T>(scope: IntegrationScope, fn: () => T): T {
  return storage.run(scope, fn);
}

export function currentIntegrationScope(): IntegrationScope | undefined {
  return storage.getStore();
}

/** The error every registering context method throws once its scope is revoked. */
export function assertIntegrationScopeLive(scope: IntegrationScope): void {
  if (scope.revoked) throw new Error(`Integration ${scope.integrationId} was unloaded`);
}

/** A `setup` still running after this long is named in a warning. */
export const SETUP_WARNING_MS = 10_000;

/**
 * An installed integration whose import and `setup` together are still
 * running after this long is left out.
 */
export const SETUP_DEADLINE_MS = 60_000;

/** A provider call that takes longer than this is named in a warning. */
export const SLOW_PROVIDER_CALL_MS = 5_000;

/**
 * The longest the host waits for one provider call of each domain, so that
 * no built-in call that can succeed is cut off: one and a half times the
 * longest a built-in provider call can take, rounded up to five seconds, and
 * never below one and a half times the HTTP client's default timeout. A call
 * that awaits timed requests one after another (retries, mirror fallbacks,
 * pages, a catalogue before its data) can take the sum of their timeouts;
 * requests that run in parallel count once. Orchestrators with a stricter
 * deadline keep theirs. The comment beside a value names the chain behind it.
 */
export const PROVIDER_CALL_DEADLINE_MS: Readonly<Record<ProviderDomain, number>> = Object.freeze({
  ...(Object.fromEntries(Object.keys(PROVIDER_SHAPES).map((domain) => [domain, 15_000])) as Record<
    ProviderDomain,
    number
  >),
  // opentransportdata.swiss trip plan on cold caches: operator list 30 s, OJP
  // on two endpoints 40 s, fares 20 s, occupancy archive 120 s, stop lists 90 s.
  transit: 450_000,
  // Valhalla: six 15 s route requests (local-access retries), a 3 s coverage trace.
  routing: 140_000,
  // Overpass: 35 s on the primary, then 35 s on the public mirror.
  "poi-search": 105_000,
  "live-transit": 45_000,
  reviews: 45_000,
  "landmark-models": 45_000,
  // Mapillary nearest image: three widening 10 s searches.
  "street-level-imagery": 45_000,
  knowledge: 30_000,
  // Mobility Database: token, 100 pages and one token refresh, 15 s each.
  "gtfs-catalog": 2_320_000,
  // GOFS quote: discovery, static files, realtime booking, wait times, 15 s each.
  "ride-hailing": 90_000,
  // The OpenConditions providers below read page by page, up to 10 s a page
  // (5 s in a routing read), until the area or their cap is read; opening a
  // site reads the box around it, then asks for the record by id.
  // 8000 sites for an EV corridor at four records each, 400 per page: 80 pages.
  "charging-sites": 1_200_000,
  // 2000 items at four records each, 400 per page: 20 pages, plus the read by id.
  "fuel-stations": 315_000,
  "parking-sites": 315_000,
  // 2000 items at four records each, 500 per page: 16 pages, plus the read by id.
  cameras: 255_000,
  "message-signs": 255_000,
  "road-weather": 255_000,
  // 1000 crossings: 8 pages, the read by id, then 4 pages of member hours.
  "border-crossings": 195_000,
  // A routing read: 100 000 situations at 5000 per page, then the evidence.
  "road-conditions": 155_000,
  // 20 000 alerts or fire pixels at 5000 per page.
  hazards: 60_000,
  // 3000 positions at 1000 per page.
  "service-vehicles": 45_000,
  // A data source opens a site through the fuel or parking providers above.
  "data-source": 315_000,
});

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Returns an object whose prototype is `provider` and whose methods run inside
 * `scope`. Every method reachable at bind time, own or inherited, gets an own
 * wrapper that calls it on `provider` itself, so private fields and `this`
 * keep working; accessors forward to `provider`, and data members are read
 * through the prototype, so `instanceof` holds and later changes to data show.
 * An asynchronous result is cut off with `ProviderTimeoutError` at the domain's
 * deadline. A `Proxy` could not do this for a frozen provider, whose
 * non-configurable methods a proxy must return unchanged. A method added to the
 * provider after binding is not wrapped. Members are captured when the
 * provider is registered, so a provider must not replace its methods
 * afterwards.
 */
export function bindProviderToScope<T extends object>(
  provider: T,
  scope: IntegrationScope,
  options: { domain: ProviderDomain; log: Logger },
): T {
  const { domain, log } = options;
  const deadlineMs = PROVIDER_CALL_DEADLINE_MS[domain];
  const bound = Object.create(provider) as T;
  const seen = new Set<PropertyKey>(["constructor"]);
  for (
    let level: object | null = provider;
    level !== null && level !== Object.prototype;
    level = Object.getPrototypeOf(level)
  ) {
    for (const key of Reflect.ownKeys(level)) {
      if (seen.has(key)) continue;
      seen.add(key);
      const descriptor = Reflect.getOwnPropertyDescriptor(level, key);
      if (!descriptor) continue;
      if (descriptor.get || descriptor.set) {
        Object.defineProperty(bound, key, {
          configurable: true,
          enumerable: descriptor.enumerable,
          get: descriptor.get ? () => Reflect.get(provider, key) : undefined,
          set: descriptor.set
            ? (value: unknown) => {
                Reflect.set(provider, key, value);
              }
            : undefined,
        });
        continue;
      }
      if (typeof descriptor.value !== "function") continue;
      const method = descriptor.value as (...args: unknown[]) => unknown;
      const methodName = typeof key === "symbol" ? key.toString() : key;
      Object.defineProperty(bound, key, {
        configurable: true,
        enumerable: descriptor.enumerable,
        writable: descriptor.writable ?? true,
        value: (...args: unknown[]) =>
          callInScope(() => Reflect.apply(method, provider, args), {
            scope,
            deadlineMs,
            onSlow: (durationMs) =>
              log.warn(`Provider call ${domain}.${methodName} took ${durationMs} ms`, {
                integrationId: scope.integrationId,
                domain,
                method: methodName,
                durationMs,
              }),
          }),
      });
    }
  }
  return bound;
}

function callInScope(
  call: () => unknown,
  options: { scope: IntegrationScope; deadlineMs: number; onSlow: (durationMs: number) => void },
): unknown {
  const startedAt = Date.now();
  const result = runInIntegrationScope(options.scope, call);
  if (!isThenable(result)) return result;
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = () => {
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      if (durationMs > SLOW_PROVIDER_CALL_MS) options.onSlow(durationMs);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settle();
      reject(new ProviderTimeoutError());
    }, options.deadlineMs);
    (timer as { unref?: () => void }).unref?.();
    result.then(
      (value) => {
        if (settled) return;
        settle();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settle();
        reject(error);
      },
    );
  });
}
