import { randomBytes as nodeRandomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  OPS_KIND_POLICIES,
  OPS_MAX_HTTP_RESPONSE_BYTES,
  OPS_MAX_REQUEST_TTL_MS,
  OPS_PROTOCOL_VERSION,
  OPS_PUBLIC_ERROR_MESSAGES,
  type OpsErrorClass,
  type OpsEventBatch,
  type OpsJobStatus,
  type OpsJobStatusFor,
  type OpsOperation,
  type OpsOperationKind,
  type OpsRequest,
  type OpsResponseEnvelope,
  type OpsSubmitResult,
  parseOpsEventBatch,
  parseOpsJobStatus,
  parseOpsJobStatusForKind,
  parseOpsResult,
} from "./contract";
import { opsOperationFingerprint } from "./fingerprint";

const TOKEN_BYTES = 43;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RESPONSE_BYTES = OPS_MAX_HTTP_RESPONSE_BYTES;
const MAX_REQUEST_TIMEOUT_MS = 30 * 60_000;
const MAX_RESPONSE_BYTES = OPS_MAX_HTTP_RESPONSE_BYTES;
const TRANSPORT_MARGIN_MS = 5_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ERROR_CLASSES = new Set<OpsErrorClass>([
  "authentication",
  "authorization",
  "validation",
  "replay",
  "stale",
  "future",
  "timeout",
  "busy",
  "conflict",
  "not_found",
  "not_wired",
  "recovery_required",
  "runtime",
]);

function isAbortError(error: unknown): boolean {
  return (
    !!error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError"
  );
}

export class OpsClientError extends Error {
  constructor(
    readonly errorClass: OpsErrorClass,
    readonly status?: number,
  ) {
    super("Ops agent request failed");
    this.name = "OpsClientError";
  }
}

export async function readOpsTokenFile(path: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size !== TOKEN_BYTES) {
      throw new Error("invalid credential");
    }
    const buffer = Buffer.alloc(TOKEN_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== TOKEN_BYTES) throw new Error("invalid credential");
    const token = buffer.subarray(0, TOKEN_BYTES).toString("utf8");
    if (!TOKEN_PATTERN.test(token)) throw new Error("invalid credential");
    return token;
  } catch {
    throw new Error("Ops agent credential is unavailable");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function validateBaseUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== "" && parsed.pathname !== "/")
    ) {
      throw new Error("suffix");
    }
    const privateHosts = new Set(["ops-agent", "localhost", "127.0.0.1", "[::1]", "::1"]);
    if (
      !privateHosts.has(parsed.hostname.toLowerCase()) ||
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    ) {
      throw new Error("scheme");
    }
    return parsed.origin;
  } catch {
    throw new Error("Invalid ops agent destination");
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new OpsClientError("runtime", response.status);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new OpsClientError("runtime", response.status);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    bytes,
  );
  return body.toString("utf8");
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
}

function parseResponse(raw: string, requestId: string, status: number): OpsResponseEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new OpsClientError("runtime", status);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OpsClientError("runtime", status);
  }
  const envelope = value as Record<string, unknown>;
  if (
    envelope.version !== OPS_PROTOCOL_VERSION ||
    envelope.requestId !== requestId ||
    typeof envelope.ok !== "boolean"
  ) {
    throw new OpsClientError("runtime", status);
  }
  if (envelope.ok === true) {
    if (!exactKeys(envelope, ["version", "requestId", "ok", "result"])) {
      throw new OpsClientError("runtime", status);
    }
    return envelope as unknown as OpsResponseEnvelope;
  }
  if (!exactKeys(envelope, ["version", "requestId", "ok", "error"])) {
    throw new OpsClientError("runtime", status);
  }
  const error = envelope.error;
  if (
    !error ||
    typeof error !== "object" ||
    Array.isArray(error) ||
    !exactKeys(error as Record<string, unknown>, ["class", "message"]) ||
    !ERROR_CLASSES.has((error as { class?: OpsErrorClass }).class as OpsErrorClass) ||
    (error as { message?: unknown }).message !==
      OPS_PUBLIC_ERROR_MESSAGES[(error as { class: OpsErrorClass }).class]
  ) {
    throw new OpsClientError("runtime", status);
  }
  return envelope as unknown as OpsResponseEnvelope;
}

export interface OpsClientOptions {
  baseUrl: string;
  tokenFile: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => Date;
  randomBytes?: (size: number) => Uint8Array;
}

export function opsRequestTimeoutMs(kind: OpsOperationKind, configuredTimeoutMs?: number): number {
  if (configuredTimeoutMs !== undefined) return configuredTimeoutMs;
  const policy = OPS_KIND_POLICIES[kind];
  if (policy.execution === "async") return DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.min(policy.timeoutMs + TRANSPORT_MARGIN_MS, MAX_REQUEST_TIMEOUT_MS);
}

export class OpsClient {
  private readonly baseUrl: string;
  private readonly tokenFile: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly signal: AbortSignal | undefined;
  private readonly configuredRequestTimeoutMs: number | undefined;
  private readonly maxResponseBytes: number;
  private readonly now: () => Date;
  private readonly randomBytes: (size: number) => Uint8Array;

  constructor(options: OpsClientOptions) {
    this.baseUrl = validateBaseUrl(options.baseUrl);
    this.tokenFile = options.tokenFile;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.signal = options.signal;
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_RESPONSE_BYTES;
    if (
      !Number.isInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1 ||
      requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS ||
      !Number.isInteger(maxResponseBytes) ||
      maxResponseBytes < 1 ||
      maxResponseBytes > MAX_RESPONSE_BYTES
    ) {
      throw new Error("Invalid ops client limits");
    }
    this.configuredRequestTimeoutMs = options.requestTimeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.now = options.now ?? (() => new Date());
    this.randomBytes = options.randomBytes ?? nodeRandomBytes;
  }

  createOperationKey(): string {
    return `opk1_${Buffer.from(this.randomBytes(18)).toString("base64url")}`;
  }

  private async get(
    path: string,
    options: { method?: "GET" | "DELETE"; signal?: AbortSignal; fingerprint?: string } = {},
  ): Promise<unknown> {
    const token = await readOpsTokenFile(this.tokenFile);
    const requestId = `ops1_${Buffer.from(this.randomBytes(18)).toString("base64url")}`;
    const timeoutSignal = AbortSignal.timeout(
      this.configuredRequestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    const signals = [timeoutSignal, this.signal, options.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: options.method ?? "GET",
        redirect: "error",
        headers: {
          authorization: `Bearer ${token}`,
          "x-ops-request-id": requestId,
          ...(options.fingerprint ? { "x-ops-operation-fingerprint": options.fingerprint } : {}),
        },
        signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
      });
      const envelope = parseResponse(
        await readBoundedBody(response, this.maxResponseBytes),
        requestId,
        response.status,
      );
      if (!envelope.ok) throw new OpsClientError(envelope.error.class, response.status);
      if (!response.ok) throw new OpsClientError("runtime", response.status);
      return envelope.result;
    } catch (error) {
      if (error instanceof OpsClientError) throw error;
      if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (timeoutSignal.aborted) throw new OpsClientError("timeout");
      throw new OpsClientError("runtime");
    }
  }

  async status<K extends OpsOperationKind>(
    kind: K,
    operationId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<OpsJobStatusFor<K>> {
    if (!/^job1_[A-Za-z0-9_-]{16,64}$/.test(operationId)) {
      throw new OpsClientError("validation");
    }
    try {
      return parseOpsJobStatusForKind(
        kind,
        await this.get(`/v1/operations/${operationId}`, { signal: options.signal }),
        { operationId },
      );
    } catch (error) {
      if (error instanceof OpsClientError) throw error;
      if (isAbortError(error)) throw new DOMException("Aborted", "AbortError");
      throw new OpsClientError("runtime");
    }
  }

  async events(
    operationId: string,
    options: { after?: number; limit?: number; signal?: AbortSignal } = {},
  ): Promise<OpsEventBatch> {
    const after = options.after ?? 0;
    const limit = options.limit ?? 100;
    if (
      !/^job1_[A-Za-z0-9_-]{16,64}$/.test(operationId) ||
      !Number.isInteger(after) ||
      after < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new OpsClientError("validation");
    }
    try {
      return parseOpsEventBatch(
        await this.get(`/v1/operations/${operationId}/events?after=${after}&limit=${limit}`, {
          signal: options.signal,
        }),
        { operationId, after },
      );
    } catch (error) {
      if (error instanceof OpsClientError) throw error;
      if (isAbortError(error)) throw new DOMException("Aborted", "AbortError");
      throw new OpsClientError("runtime");
    }
  }

  async cancel(operationId: string, options: { signal?: AbortSignal } = {}): Promise<OpsJobStatus> {
    if (!/^job1_[A-Za-z0-9_-]{16,64}$/.test(operationId)) {
      throw new OpsClientError("validation");
    }
    try {
      const status = parseOpsJobStatus(
        await this.get(`/v1/operations/${operationId}`, {
          method: "DELETE",
          signal: options.signal,
        }),
      );
      if (status.operationId !== operationId) throw new Error("Operation status ID mismatch");
      return status;
    } catch (error) {
      if (error instanceof OpsClientError) throw error;
      if (isAbortError(error)) throw new DOMException("Aborted", "AbortError");
      throw new OpsClientError("runtime");
    }
  }

  async lookup<K extends OpsOperationKind>(
    operation: Extract<OpsOperation, { kind: K }>,
    operationKey: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<OpsJobStatusFor<K>> {
    if (!/^opk1_[A-Za-z0-9_-]{16,64}$/.test(operationKey)) throw new OpsClientError("validation");
    try {
      const status = parseOpsJobStatusForKind(
        operation.kind,
        await this.get(`/v1/operation-keys/${operationKey}`, {
          signal: options.signal,
          fingerprint: opsOperationFingerprint(operation),
        }),
        {},
      );
      if (status.operationKey !== operationKey || status.kind !== operation.kind) {
        throw new OpsClientError("runtime");
      }
      return status;
    } catch (error) {
      if (error instanceof OpsClientError) throw error;
      if (isAbortError(error)) throw new DOMException("Aborted", "AbortError");
      throw new OpsClientError("runtime");
    }
  }

  async execute<K extends OpsOperationKind>(
    operation: Extract<OpsOperation, { kind: K }>,
    options: { operationKey?: string; signal?: AbortSignal } = {},
  ): Promise<OpsSubmitResult<K>> {
    if (OPS_KIND_POLICIES[operation.kind].execution === "async" && !options.operationKey) {
      throw new Error("Async operation key is required");
    }
    const token = await readOpsTokenFile(this.tokenFile);
    const issued = this.now();
    const requestId = `ops1_${Buffer.from(this.randomBytes(18)).toString("base64url")}`;
    const operationKey = options.operationKey ?? this.createOperationKey();
    const request: OpsRequest = {
      version: OPS_PROTOCOL_VERSION,
      requestId,
      operationKey,
      issuedAt: issued.toISOString(),
      expiresAt: new Date(
        issued.getTime() + Math.min(20_000, OPS_MAX_REQUEST_TTL_MS),
      ).toISOString(),
      operation,
    };
    const timeoutSignal = AbortSignal.timeout(
      opsRequestTimeoutMs(operation.kind, this.configuredRequestTimeoutMs),
    );
    const signals = [timeoutSignal, this.signal, options.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/operations`, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
      });
      const envelope = parseResponse(
        await readBoundedBody(response, this.maxResponseBytes),
        requestId,
        response.status,
      );
      if (!envelope.ok) throw new OpsClientError(envelope.error.class, response.status);
      if (!response.ok) throw new OpsClientError("runtime", response.status);
      const result = envelope.result;
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new OpsClientError("runtime", response.status);
      }
      const submit = result as Record<string, unknown>;
      if (OPS_KIND_POLICIES[operation.kind].execution === "sync") {
        if (
          !exactKeys(submit, ["execution", "kind", "value"]) ||
          submit.execution !== "sync" ||
          submit.kind !== operation.kind
        ) {
          throw new OpsClientError("runtime", response.status);
        }
        return {
          execution: "sync",
          kind: operation.kind,
          value: parseOpsResult(operation.kind, submit.value),
        } as OpsSubmitResult<K>;
      }
      if (
        !exactKeys(submit, ["execution", "operationId", "operationKey", "kind", "state"]) ||
        submit.execution !== "async" ||
        submit.kind !== operation.kind ||
        submit.operationKey !== operationKey ||
        typeof submit.operationId !== "string" ||
        !/^job1_[A-Za-z0-9_-]{16,64}$/.test(submit.operationId) ||
        !["queued", "running", "succeeded", "failed", "termination_pending", "timed_out"].includes(
          String(submit.state),
        )
      ) {
        throw new OpsClientError("runtime", response.status);
      }
      return submit as unknown as OpsSubmitResult<K>;
    } catch (error) {
      if (error instanceof OpsClientError) throw error;
      if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (timeoutSignal.aborted) throw new OpsClientError("timeout");
      throw new OpsClientError("runtime");
    }
  }
}
