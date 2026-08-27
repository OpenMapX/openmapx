import {
  Agent,
  buildConnector,
  type Dispatcher,
  type RequestInit as UndiciRequestInit,
  fetch as undiciFetch,
} from "undici";
import type { FetchConnectionAddress, ReleaseResponseOptions } from "./fetchWithRedirects";

interface PinnedDispatcher {
  close(): Promise<void>;
  destroy(error?: Error): Promise<void>;
}

const PINNED_DISPATCHER_CLEANUP_ATTEMPTS = 3;
const PINNED_DISPATCHER_CLEANUP_ATTEMPT_MS = 250;
const PINNED_DISPATCHER_CLEANUP_TOTAL_MS = 1_500;
const pendingDispatcherCleanup = new Map<PinnedDispatcher, ReleaseResponseOptions>();

type PinnedFetchRequestInit = RequestInit & { dispatcher?: PinnedDispatcher };

export interface PinnedFetchTransport {
  fetch(
    input: string | URL,
    addresses: FetchConnectionAddress[],
    init: RequestInit,
  ): Promise<Response>;
  releaseResponse(response: Response, options?: ReleaseResponseOptions): Promise<void>;
  dispose(options?: ReleaseResponseOptions): Promise<void>;
}

export interface PinnedFetchTransportOptions {
  /** Test seam for the socket-owning dispatcher; production uses a direct Undici Agent. */
  createDispatcher?: (addresses: FetchConnectionAddress[]) => PinnedDispatcher;
  /** Test seam for the paired direct Undici fetch implementation. */
  fetchImplementation?: (input: string | URL, init: PinnedFetchRequestInit) => Promise<Response>;
}

function createPinnedDispatcher(addresses: FetchConnectionAddress[]): Dispatcher {
  if (!addresses.length) throw new Error("No validated addresses available for connection");
  const connector = buildConnector({});
  let nextAddress = 0;
  return new Agent({
    connect(options, callback) {
      const connectNext = (): void => {
        const address = addresses[nextAddress++];
        connector(
          {
            ...options,
            hostname: address.address,
            // Preserve the requested hostname for TLS certificate verification and SNI.
            servername: options.servername ?? options.hostname,
          },
          (error, socket) => {
            if (error) {
              if (nextAddress < addresses.length) {
                connectNext();
                return;
              }
              callback(error, null);
              return;
            }
            callback(null, socket);
          },
        );
      };
      connectNext();
    },
  });
}

async function boundedDispatcherAttempt(
  operation: () => Promise<void>,
  deadlineAt: number,
): Promise<void> {
  const operationPromise = Promise.resolve().then(operation);
  const remainingMs = Math.min(
    PINNED_DISPATCHER_CLEANUP_ATTEMPT_MS,
    Math.max(0, deadlineAt - Date.now()),
  );
  if (remainingMs === 0) {
    void operationPromise.catch(() => {});
    throw new Error("Pinned fetch dispatcher cleanup deadline exceeded");
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Pinned fetch dispatcher cleanup attempt timed out")),
      remainingMs,
    );
    timer.unref();
  });
  try {
    await Promise.race([operationPromise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeDispatcher(dispatcher: PinnedDispatcher, deadlineAt: number): Promise<void> {
  try {
    await boundedDispatcherAttempt(() => dispatcher.close(), deadlineAt);
  } catch {
    await boundedDispatcherAttempt(() => dispatcher.destroy(), deadlineAt);
  }
}

async function settleDispatcher(
  dispatcher: PinnedDispatcher,
  options: ReleaseResponseOptions = {},
): Promise<void> {
  const pendingOptions = pendingDispatcherCleanup.get(dispatcher);
  const mustForce = options.force === true || pendingOptions?.force === true;
  const cleanupDeadlineAt = Math.min(
    options.cleanupDeadlineAt ?? Number.POSITIVE_INFINITY,
    Date.now() + PINNED_DISPATCHER_CLEANUP_TOTAL_MS,
  );
  let lastError: unknown;
  for (let attempt = 0; attempt < PINNED_DISPATCHER_CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      if (mustForce) {
        await boundedDispatcherAttempt(() => dispatcher.destroy(), cleanupDeadlineAt);
      } else {
        await closeDispatcher(dispatcher, cleanupDeadlineAt);
      }
      pendingDispatcherCleanup.delete(dispatcher);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  pendingDispatcherCleanup.set(dispatcher, mustForce ? { force: true } : {});
  throw new Error("Pinned fetch dispatcher cleanup failed", { cause: lastError });
}

async function scavengePendingDispatchers(): Promise<void> {
  const failures: unknown[] = [];
  const cleanupDeadlineAt = Date.now() + PINNED_DISPATCHER_CLEANUP_TOTAL_MS;
  for (const [dispatcher, options] of [...pendingDispatcherCleanup]) {
    try {
      await settleDispatcher(dispatcher, { ...options, cleanupDeadlineAt });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new Error("Pinned fetch dispatcher scavenging failed", { cause: failures[0] });
  }
}

/**
 * Server-only transport that pairs direct Undici fetch with the same-version
 * Agent controlling DNS-pinned socket connection. Every created Agent is
 * released after the associated response body is consumed/canceled, or
 * immediately if fetching fails before a response exists.
 */
export function createPinnedFetchTransport(
  options: PinnedFetchTransportOptions = {},
): PinnedFetchTransport {
  const fetchImplementation =
    options.fetchImplementation ??
    ((input: string | URL, init: PinnedFetchRequestInit) =>
      undiciFetch(input, init as unknown as UndiciRequestInit) as unknown as Promise<Response>);
  const createDispatcher = options.createDispatcher ?? createPinnedDispatcher;
  const dispatchers = new Set<PinnedDispatcher>();
  const responseDispatchers = new WeakMap<Response, PinnedDispatcher>();

  const releaseDispatcher = async (
    dispatcher: PinnedDispatcher,
    options: ReleaseResponseOptions = {},
  ): Promise<void> => {
    if (!dispatchers.has(dispatcher)) return;
    await settleDispatcher(dispatcher, options);
    dispatchers.delete(dispatcher);
  };

  return {
    async fetch(input, addresses, init) {
      await scavengePendingDispatchers();
      const dispatcher = createDispatcher(addresses);
      dispatchers.add(dispatcher);
      try {
        const response = await fetchImplementation(input, { ...init, dispatcher });
        responseDispatchers.set(response, dispatcher);
        return response;
      } catch (error) {
        try {
          await releaseDispatcher(dispatcher);
        } catch {
          // The original connection/setup failure is authoritative. The
          // dispatcher remains owned by both the transport and process
          // scavenger until a later bounded cleanup succeeds.
        }
        throw error;
      }
    },
    async releaseResponse(response, options) {
      const dispatcher = responseDispatchers.get(response);
      if (!dispatcher) return;
      await releaseDispatcher(dispatcher, options);
      responseDispatchers.delete(response);
    },
    async dispose(options) {
      const results = await Promise.allSettled(
        [...dispatchers].map((dispatcher) => releaseDispatcher(dispatcher, options)),
      );
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") {
        throw new Error("Pinned fetch transport cleanup failed", { cause: failure.reason });
      }
    },
  };
}
