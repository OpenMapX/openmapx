import {
  Agent,
  buildConnector,
  type Dispatcher,
  type RequestInit as UndiciRequestInit,
  fetch as undiciFetch,
} from "undici";
import type { FetchConnectionAddress } from "./fetchWithRedirects";

interface PinnedDispatcher {
  close(): Promise<void>;
  destroy(error?: Error): Promise<void>;
}

type PinnedFetchRequestInit = RequestInit & { dispatcher?: PinnedDispatcher };

export interface PinnedFetchTransport {
  fetch(
    input: string | URL,
    addresses: FetchConnectionAddress[],
    init: RequestInit,
  ): Promise<Response>;
  releaseResponse(response: Response): Promise<void>;
  dispose(): Promise<void>;
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

async function closeDispatcher(dispatcher: PinnedDispatcher): Promise<void> {
  try {
    await dispatcher.close();
  } catch {
    await dispatcher.destroy();
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

  const releaseDispatcher = async (dispatcher: PinnedDispatcher): Promise<void> => {
    if (!dispatchers.delete(dispatcher)) return;
    await closeDispatcher(dispatcher);
  };

  return {
    async fetch(input, addresses, init) {
      const dispatcher = createDispatcher(addresses);
      dispatchers.add(dispatcher);
      try {
        const response = await fetchImplementation(input, { ...init, dispatcher });
        responseDispatchers.set(response, dispatcher);
        return response;
      } catch (error) {
        await releaseDispatcher(dispatcher);
        throw error;
      }
    },
    async releaseResponse(response) {
      const dispatcher = responseDispatchers.get(response);
      if (!dispatcher) return;
      responseDispatchers.delete(response);
      await releaseDispatcher(dispatcher);
    },
    async dispose() {
      await Promise.all([...dispatchers].map((dispatcher) => releaseDispatcher(dispatcher)));
    },
  };
}
