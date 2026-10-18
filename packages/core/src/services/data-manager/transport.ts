import { readBoundedJsonResponse } from "../../utils/fetchJson";
import { type DataManagerOperation, dataManagerOperations } from "./contracts";

export const DATA_MANAGER_PLAINTEXT_HOSTS_ENV = "DATA_MANAGER_PLAINTEXT_HOSTS";
export function validateDataManagerBaseUrl(
  value: string,
  options: { allowPlaintextHosts?: readonly string[] } = {},
): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid data-manager base URL");
  }
  if (
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("Invalid data-manager base URL: credentials and URL suffixes are not allowed");
  const configured =
    typeof process === "undefined" ? "" : (process.env?.[DATA_MANAGER_PLAINTEXT_HOSTS_ENV] ?? "");
  const allowed = new Set([
    "localhost",
    "127.0.0.1",
    "[::1]",
    "::1",
    "data-manager",
    ...(options.allowPlaintextHosts ?? configured.split(","))
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  ]);
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && allowed.has(parsed.hostname.toLowerCase()))
  )
    throw new Error(
      `Data-manager destination must use HTTPS or an approved loopback/Compose hostname (extend with ${DATA_MANAGER_PLAINTEXT_HOSTS_ENV})`,
    );
  return parsed.origin;
}

export class DataManagerHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DataManagerHttpError";
  }
}
export class DataManagerContractError extends Error {
  constructor(
    readonly operationId: string,
    readonly status: number,
    reason: string,
  ) {
    super(`Data-manager ${operationId} response contract failed (HTTP ${status}): ${reason}`);
    this.name = "DataManagerContractError";
  }
}

type OperationId = keyof typeof dataManagerOperations;
export interface DataManagerTransportOptions {
  baseUrl: string;
  authToken?: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  maxJsonBytes?: number;
  maxStreamBytes?: number;
  streamIdleTimeoutMs?: number;
  allowPlaintextHosts?: readonly string[];
}
export type DataManagerRequestOptions = RequestInit & { transport?: DataManagerTransport };
export interface DataManagerTransport {
  request<T>(operationId: OperationId, url: string, options?: RequestInit): Promise<T>;
}
export interface DataManagerStreamContext {
  signal: AbortSignal;
  maxBytes: number;
  idleTimeoutMs: number;
}
const streamContexts = new WeakMap<Response, DataManagerStreamContext>();
export function getDataManagerStreamContext(
  response: Response,
): DataManagerStreamContext | undefined {
  return streamContexts.get(response);
}

function positive(value: number | undefined, fallback: number): number {
  const actual = value ?? fallback;
  if (!Number.isFinite(actual) || actual <= 0)
    throw new Error("Data-manager acquisition limits must be positive finite numbers");
  return actual;
}
async function cancel(response: Response): Promise<void> {
  // Cancellation must not hide the original contract error or hold it indefinitely.
  if (!response.body) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      response.body.cancel().catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 250);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
async function withSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
function mediaType(response: Response): string {
  return ((response.headers.get("content-type") ?? "").split(";", 1)[0] ?? "").trim().toLowerCase();
}
function matchesOperationPath(path: string, template: string): boolean {
  const expected = template.split("/");
  const actual = path.split("/");
  return (
    expected.length === actual.length &&
    expected.every((segment, index) => {
      const pattern = segment
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\\\{[^}]+\\\}/g, "[^/]+")
        .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "[^/]+");
      return new RegExp(`^${pattern}$`).test(actual[index] ?? "");
    })
  );
}

/** Explicit service acquisition policy, shared by every generated operation. */
export function createDataManagerTransport(
  options: DataManagerTransportOptions,
): DataManagerTransport {
  const baseUrl = validateDataManagerBaseUrl(options.baseUrl, options);
  const acquire = options.fetch ?? globalThis.fetch;
  const timeoutMs = positive(options.requestTimeoutMs, 15_000);
  const maxJsonBytes = positive(options.maxJsonBytes, 8 * 1024 * 1024);
  const maxBytes = positive(options.maxStreamBytes, 8 * 1024 * 1024);
  const idleTimeoutMs = positive(options.streamIdleTimeoutMs, 5 * 60_000);
  return {
    async request<T>(operationId: OperationId, url: string, init: RequestInit = {}): Promise<T> {
      const operation: DataManagerOperation = dataManagerOperations[operationId];
      const destination = new URL(url, baseUrl);
      if (
        destination.origin !== baseUrl ||
        !url.startsWith("/") ||
        url.startsWith("//") ||
        destination.hash ||
        !matchesOperationPath(destination.pathname, operation.path) ||
        (init.method ?? "GET").toUpperCase() !== operation.method.toUpperCase()
      )
        throw new Error("Data-manager request does not match its bound operation");
      const timeout = new AbortController();
      const timer = setTimeout(
        () => timeout.abort(new Error("Data-manager request timeout")),
        timeoutMs,
      );
      const callerSignals = [options.signal, init.signal].filter((value): value is AbortSignal =>
        Boolean(value),
      );
      const callerSignal = callerSignals.length
        ? AbortSignal.any(callerSignals)
        : new AbortController().signal;
      const signal = AbortSignal.any([callerSignal, timeout.signal]);
      let response: Response | undefined;
      try {
        signal.throwIfAborted();
        const headers = new Headers(init.headers);
        if (
          operation.auth === "service" &&
          options.authToken &&
          !headers.has("authorization") &&
          !headers.has("x-data-manager-token")
        )
          headers.set("authorization", `Bearer ${options.authToken}`);
        const pending = Promise.resolve(
          acquire(destination.href, {
            ...init,
            headers,
            signal,
            redirect: "error",
            credentials: "omit",
          }),
        );
        // A fetch implementation can ignore cancellation. Retain ownership of its late body.
        void pending
          .then(
            (late) => {
              if (signal.aborted && late !== response) return cancel(late);
              return undefined;
            },
            () => {},
          )
          .catch(() => {});
        response = await withSignal(pending, signal);
        const contract = operation.responses[response.status];
        if (!contract)
          throw new DataManagerContractError(operationId, response.status, "undeclared status");
        if (contract.headers) {
          const values: Record<string, string> = {};
          response.headers.forEach((value, name) => {
            values[name.toLowerCase()] = value;
          });
          try {
            contract.headers.parse(values);
          } catch {
            throw new DataManagerContractError(
              operationId,
              response.status,
              "invalid response headers",
            );
          }
        }
        if (contract.kind === "empty") {
          await cancel(response);
          return { status: response.status, headers: response.headers, data: undefined } as T;
        }
        if (contract.kind === "raw" || contract.kind === "ndjson") {
          const accepted =
            contract.kind === "raw" ? contract.contentTypes : ["application/x-ndjson"];
          if (
            !mediaType(response) ||
            (!accepted.includes("*/*") && !accepted.includes(mediaType(response)))
          )
            throw new DataManagerContractError(
              operationId,
              response.status,
              "unexpected content type",
            );
          if (contract.kind === "ndjson")
            streamContexts.set(response, { signal: callerSignal, maxBytes, idleTimeoutMs });
          return {
            status: response.status,
            headers: response.headers,
            ...(contract.kind === "ndjson" ? { stream: response } : { data: response }),
          } as T;
        }
        if (mediaType(response) !== "application/json")
          throw new DataManagerContractError(
            operationId,
            response.status,
            "unexpected content type",
          );
        let body: unknown;
        try {
          body = await readBoundedJsonResponse<unknown>(response, {
            maxBytes: maxJsonBytes,
            signal,
            label: `Data-manager ${operationId}`,
          });
        } catch (error) {
          if (error instanceof SyntaxError)
            throw new DataManagerContractError(operationId, response.status, "invalid JSON");
          throw error;
        }
        let data: unknown;
        try {
          data = contract.schema.parse(body);
        } catch {
          throw new DataManagerContractError(operationId, response.status, "invalid body");
        }
        return { status: response.status, headers: response.headers, data } as T;
      } catch (error) {
        if (response && !response.body?.locked) await cancel(response);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Binding identity stays in this closure; request options cannot choose a validator. */
export function bindDataManagerOperation(operationId: OperationId) {
  return async <T>(url: string, options: DataManagerRequestOptions = {}): Promise<T> => {
    const { transport, ...request } = options;
    if (!transport) throw new Error("An explicit data-manager transport is required");
    // Copy only Fetch fields: forged metadata never reaches the acquisition adapter.
    const {
      method,
      headers,
      body,
      signal,
      cache,
      integrity,
      keepalive,
      mode,
      referrer,
      referrerPolicy,
    } = request;
    return transport.request<T>(operationId, url, {
      method,
      headers,
      body,
      signal,
      cache,
      integrity,
      keepalive,
      mode,
      referrer,
      referrerPolicy,
    });
  };
}

type Successful<T> = T extends { status: infer S extends number }
  ? `${S}` extends `2${string}`
    ? T
    : never
  : never;
export function unwrapDataManagerResponse<T extends { status: number; data?: unknown }>(
  response: T,
): Successful<T> extends { data: infer D } ? D : T["data"] {
  if (response.status < 200 || response.status >= 300) {
    const body = response.data;
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `Data-manager HTTP ${response.status}`;
    throw new DataManagerHttpError(message, response.status);
  }
  return response.data as Successful<T> extends { data: infer D } ? D : T["data"];
}
