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

/** An installed integration's `setup` still running after this long is left out. */
export const SETUP_DEADLINE_MS = 60_000;

/** A provider call that takes longer than this is named in a warning. */
export const SLOW_PROVIDER_CALL_MS = 5_000;

/**
 * The longest the host waits for one provider call of each domain: one and a
 * half times the largest timeout a built-in provider awaits inside one call,
 * rounded up to five seconds, and never below one and a half times the HTTP
 * client's default timeout. Orchestrators with a stricter deadline keep theirs.
 */
export const PROVIDER_CALL_DEADLINE_MS: Readonly<Record<ProviderDomain, number>> = Object.freeze({
  ...(Object.fromEntries(Object.keys(PROVIDER_SHAPES).map((domain) => [domain, 15_000])) as Record<
    ProviderDomain,
    number
  >),
  transit: 180_000,
  routing: 60_000,
  "poi-search": 55_000,
  "live-transit": 45_000,
  reviews: 45_000,
  "landmark-models": 45_000,
  "street-level-imagery": 40_000,
  knowledge: 30_000,
  "gtfs-catalog": 25_000,
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
 * through the prototype, so `instanceof` holds and later changes show. An
 * asynchronous result is cut off with `ProviderTimeoutError` at the domain's
 * deadline. A `Proxy` could not do this for a frozen provider, whose
 * non-configurable methods a proxy must return unchanged. A method added to the
 * provider after binding is not wrapped.
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
