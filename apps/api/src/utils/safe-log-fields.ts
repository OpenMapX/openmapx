import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { types as utilTypes } from "node:util";
import type { LogFn, Logger, LoggerOptions } from "pino";

const MAX_DEPTH = 4;
const MAX_CONTAINER_ITEMS = 50;
const MAX_STRING_CHARACTERS = 2_048;
const MAX_SERIALIZED_BYTES = 16 * 1_024;
const MAX_VISITED_VALUES = 4_096;
const MAX_PINO_RECORD_INPUT_BYTES = 64 * 1_024;

const REDACTED = "[redacted]";
const UNAVAILABLE = "[unavailable]";
const UNSUPPORTED = "[unsupported]";
const CIRCULAR = "[circular]";
const MAX_DEPTH_REACHED = "[max-depth]";
const METADATA_TOO_LARGE = "[metadata exceeds 16 KiB]";
const INVALID_OR_OVERSIZED_RECORD = "[invalid-or-oversized-record]";

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu;
const ORIGIN_FORM_QUERY_PATTERN = /(^|[\s("'])\/[^\s"'<>]*[?#][^\s"'<>]*/gu;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const EMAIL_PATTERN = /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|token|password|secret|apikey|credential|session|url|user.?id|email)/iu;
const URL_KEY_PATTERN = /url/iu;
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

declare const externalUrlSummaryBrand: unique symbol;

export type ExternalUrlSummary = Readonly<{
  host: string;
  digest: string;
  readonly [externalUrlSummaryBrand]: true;
}>;

const externalUrlSummaries = new WeakSet<object>();

interface SanitizeState {
  readonly allowSerializedUrlSummaries: boolean;
  readonly seen: WeakSet<object>;
  readonly sanitizePatterns: boolean;
  visited: number;
}

function plainObject(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

// Pino's child-binding encoder calls `hasOwnProperty` on the bindings object it
// is handed, so every sanitized record that crosses into Pino must carry an
// ordinary prototype instead of the null-prototype representation used
// everywhere else. Only the top level needs converting: nested values are
// serialized with JSON.stringify, which handles null-prototype objects.
function ownedObject(value: Record<string, unknown>): Record<string, unknown> {
  return { ...value };
}

function truncateCharacters(value: string): string {
  let count = 0;
  let output = "";
  for (const character of value) {
    if (count >= MAX_STRING_CHARACTERS) break;
    output += character;
    count += 1;
  }
  return output;
}

function truncateMessage(value: string): string {
  let bytes = 0;
  let count = 0;
  let output = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (count >= MAX_STRING_CHARACTERS || bytes + characterBytes > MAX_STRING_CHARACTERS) break;
    output += character;
    bytes += characterBytes;
    count += 1;
  }
  return output;
}

export function sanitizeLogString(value: string): string {
  const withoutUrls = value
    .replace(URL_PATTERN, "[redacted-url]")
    .replace(ORIGIN_FORM_QUERY_PATTERN, "$1[redacted-url]")
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(EMAIL_PATTERN, "[redacted-email]");
  return truncateMessage(withoutUrls);
}

export function summarizeExternalUrl(raw: string): ExternalUrlSummary {
  const summary = plainObject() as {
    host: string;
    digest: string;
    readonly [externalUrlSummaryBrand]: true;
  };
  summary.digest = createHash("sha256").update(raw).digest("hex").slice(0, 32);
  try {
    const parsed = new URL(raw);
    summary.host = parsed.hostname.toLowerCase() || "invalid";
  } catch {
    summary.host = "invalid";
  }
  externalUrlSummaries.add(summary);
  return Object.freeze(summary);
}

function isExternalUrlSummary(value: unknown): value is ExternalUrlSummary {
  return typeof value === "object" && value !== null && externalUrlSummaries.has(value);
}

function safeOwnDescriptor(value: object, key: PropertyKey): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return undefined;
  }
}

function safeErrorData(error: Error, key: "name" | "message" | "stack"): unknown {
  let current: object | null = error;
  for (let depth = 0; current !== null && depth <= MAX_DEPTH; depth += 1) {
    const descriptor = safeOwnDescriptor(current, key);
    if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
    try {
      current = Object.getPrototypeOf(current) as object | null;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isError(value: object): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

export function safeErrorClass(value: unknown): string {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value) || !isError(value))
    return "NonError";
  const name = safeErrorData(value, "name");
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) ? name : "Error";
}

function sanitizeError(error: Error, sanitizePatterns: boolean): Record<string, unknown> {
  const output = plainObject();
  output.name = safeErrorClass(error);
  for (const key of ["message", "stack"] as const) {
    const value = safeErrorData(error, key);
    if (typeof value === "string") {
      output[key] = sanitizePatterns ? sanitizeLogString(value) : truncateCharacters(value);
    }
  }
  return output;
}

function sanitizedSummary(summary: ExternalUrlSummary): Record<string, unknown> {
  const output = plainObject();
  output.host = summary.host;
  output.digest = summary.digest;
  return output;
}

function serializedSummary(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value)) return undefined;
  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return undefined;
  }
  if (keys.length !== 2 || !keys.includes("host") || !keys.includes("digest")) return undefined;
  const hostDescriptor = safeOwnDescriptor(value, "host");
  const digestDescriptor = safeOwnDescriptor(value, "digest");
  if (
    !hostDescriptor ||
    !("value" in hostDescriptor) ||
    !digestDescriptor ||
    !("value" in digestDescriptor) ||
    typeof hostDescriptor.value !== "string" ||
    !/^[A-Za-z0-9.:[\]-]{1,253}$/u.test(hostDescriptor.value) ||
    typeof digestDescriptor.value !== "string" ||
    !/^[a-f0-9]{32}$/u.test(digestDescriptor.value)
  ) {
    return undefined;
  }
  const output = plainObject();
  output.host = hostDescriptor.value.toLowerCase();
  output.digest = digestDescriptor.value;
  return output;
}

function sanitizeArray(value: unknown[], depth: number, state: SanitizeState): unknown[] | string {
  if (depth >= MAX_DEPTH) return MAX_DEPTH_REACHED;
  const output: unknown[] = [];
  const lengthDescriptor = safeOwnDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor)) return UNAVAILABLE;
  const rawLength = lengthDescriptor.value;
  if (typeof rawLength !== "number" || !Number.isSafeInteger(rawLength) || rawLength < 0) {
    return UNAVAILABLE;
  }
  const length = Math.min(rawLength, MAX_CONTAINER_ITEMS);
  for (let index = 0; index < length; index += 1) {
    const descriptor = safeOwnDescriptor(value, String(index));
    if (!descriptor) {
      output.push(UNAVAILABLE);
      continue;
    }
    output.push(
      "value" in descriptor ? sanitizeValue(descriptor.value, depth + 1, state) : REDACTED,
    );
  }
  return output;
}

function sanitizeObject(
  value: object,
  depth: number,
  state: SanitizeState,
): Record<string, unknown> | string {
  if (depth >= MAX_DEPTH) return MAX_DEPTH_REACHED;

  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return UNAVAILABLE;
  }

  const output = plainObject();
  let items = 0;
  for (const key of keys) {
    if (typeof key !== "string") continue;
    const descriptor = safeOwnDescriptor(value, key);
    if (!descriptor) return UNAVAILABLE;
    if (!descriptor.enumerable) continue;
    if (items >= MAX_CONTAINER_ITEMS) break;
    items += 1;

    if (DANGEROUS_KEYS.has(key) || SENSITIVE_KEY_PATTERN.test(key)) {
      const externalSummary =
        URL_KEY_PATTERN.test(key) && "value" in descriptor
          ? isExternalUrlSummary(descriptor.value)
            ? sanitizedSummary(descriptor.value)
            : state.allowSerializedUrlSummaries
              ? serializedSummary(descriptor.value)
              : undefined
          : undefined;
      output[key] = externalSummary ?? REDACTED;
      continue;
    }
    output[key] =
      "value" in descriptor ? sanitizeValue(descriptor.value, depth + 1, state) : REDACTED;
  }
  return output;
}

function sanitizeValue(value: unknown, depth: number, state: SanitizeState): unknown {
  state.visited += 1;
  if (state.visited > MAX_VISITED_VALUES) return "[value-budget-exceeded]";

  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return state.sanitizePatterns ? sanitizeLogString(value) : truncateCharacters(value);
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return truncateCharacters(value.toString());
  if (typeof value !== "object") return UNSUPPORTED;
  if (utilTypes.isProxy(value)) return REDACTED;

  if (isExternalUrlSummary(value)) return sanitizedSummary(value);
  if (state.seen.has(value)) return CIRCULAR;
  state.seen.add(value);

  if (isError(value)) return sanitizeError(value, state.sanitizePatterns);
  try {
    if (Array.isArray(value)) return sanitizeArray(value, depth, state);
  } catch {
    return UNAVAILABLE;
  }
  return sanitizeObject(value, depth, state);
}

function withinSerializedLimit(value: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_SERIALIZED_BYTES;
  } catch {
    return false;
  }
}

function stringifyOwnedValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? UNSUPPORTED;
  } catch {
    return UNAVAILABLE;
  }
}

function formatOwnedValue(value: unknown, token: string): string {
  if (token === "%j" || token === "%o" || token === "%O") return stringifyOwnedValue(value);
  if (token === "%d" || token === "%i" || token === "%f") {
    if (typeof value === "number") return String(value);
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "boolean") return value ? "1" : "0";
    if (typeof value === "string") {
      const parsed = token === "%f" ? Number.parseFloat(value) : Number.parseInt(value, 10);
      return String(parsed);
    }
    return "NaN";
  }
  return stringifyOwnedValue(value);
}

function reconstructSafeMessage(format: unknown, values: readonly unknown[]): string {
  const boundedValues = values.slice(0, MAX_CONTAINER_ITEMS);
  if (typeof format !== "string") {
    return sanitizeLogString(
      [stringifyOwnedValue(format), ...boundedValues.map(stringifyOwnedValue)].join(" "),
    );
  }

  let valueIndex = 0;
  const formatted = format.replace(/%[%sdifjoO]/gu, (token) => {
    if (token === "%%") return "%";
    if (valueIndex >= boundedValues.length) return token;
    const value = boundedValues[valueIndex];
    valueIndex += 1;
    return formatOwnedValue(value, token);
  });
  const remaining = boundedValues.slice(valueIndex).map(stringifyOwnedValue);
  return sanitizeLogString(
    remaining.length === 0 ? formatted : `${formatted} ${remaining.join(" ")}`,
  );
}

function sanitizedPinoArguments(args: Parameters<LogFn>): Parameters<LogFn> {
  const bounded = args.slice(0, MAX_CONTAINER_ITEMS + 2);
  if (bounded.length === 0) return [] as unknown as Parameters<LogFn>;

  const first = sanitizeLogValue(bounded[0]);
  const hasStructuredFirst = first === null || (typeof first === "object" && !Array.isArray(first));
  if (hasStructuredFirst) {
    if (bounded.length === 1) return [first] as Parameters<LogFn>;
    const message = reconstructSafeMessage(
      sanitizeLogFormatValue(bounded[1]),
      bounded.slice(2).map(sanitizeLogFormatValue),
    );
    return [first, message] as Parameters<LogFn>;
  }

  return [
    reconstructSafeMessage(
      sanitizeLogFormatValue(bounded[0]),
      bounded.slice(1).map(sanitizeLogFormatValue),
    ),
  ] as Parameters<LogFn>;
}

export function sanitizeLogValue(value: unknown): unknown {
  const sanitized = sanitizeValue(value, 0, {
    allowSerializedUrlSummaries: false,
    seen: new WeakSet(),
    sanitizePatterns: true,
    visited: 0,
  });
  if (withinSerializedLimit(sanitized)) return sanitized;
  const output = plainObject();
  output.truncated = METADATA_TOO_LARGE;
  return output;
}

function sanitizeLogFormatValue(value: unknown): unknown {
  const sanitized = sanitizeValue(value, 0, {
    allowSerializedUrlSummaries: false,
    seen: new WeakSet(),
    sanitizePatterns: false,
    visited: 0,
  });
  if (withinSerializedLimit(sanitized)) return sanitized;
  const output = plainObject();
  output.truncated = METADATA_TOO_LARGE;
  return output;
}

export function sanitizeLogMetadata(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeLogValue(value);
  if (typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized)) {
    return sanitized as Record<string, unknown>;
  }
  const output = plainObject();
  output.value = sanitized;
  return output;
}

const PINO_RECORD_CORE_KEYS = new Set(["level", "time", "pid", "hostname", "name", "msg"]);
const PINO_RECORD_ALWAYS_REDACT_KEYS = new Set([
  "req",
  "request",
  "res",
  "raw",
  "headers",
  "body",
  "query",
]);

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function sanitizedRecordField(key: string, value: unknown): unknown {
  if (PINO_RECORD_ALWAYS_REDACT_KEYS.has(key)) return REDACTED;
  const holder = plainObject();
  holder[key] = value;
  const sanitized = sanitizeValue(holder, 0, {
    allowSerializedUrlSummaries: true,
    seen: new WeakSet(),
    sanitizePatterns: true,
    visited: 0,
  });
  if (typeof sanitized !== "object" || sanitized === null || Array.isArray(sanitized)) {
    return REDACTED;
  }
  return (sanitized as Record<string, unknown>)[key] ?? REDACTED;
}

function addMetadataTruncationMarker(
  output: Record<string, unknown>,
  retainedKeys: string[],
): void {
  output.metadataTruncated = METADATA_TOO_LARGE;
  while (serializedBytes(output) > MAX_SERIALIZED_BYTES && retainedKeys.length > 0) {
    const key = retainedKeys.pop();
    if (key !== undefined) delete output[key];
  }
}

function sanitizeCompleteRecordMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const output = plainObject();
  const retainedKeys: string[] = [];
  let items = 0;
  for (const key of Object.keys(record)) {
    if (PINO_RECORD_CORE_KEYS.has(key)) continue;
    if (items >= MAX_CONTAINER_ITEMS) {
      addMetadataTruncationMarker(output, retainedKeys);
      break;
    }
    items += 1;
    output[key] = sanitizedRecordField(key, record[key]);
    if (serializedBytes(output) > MAX_SERIALIZED_BYTES) {
      delete output[key];
      addMetadataTruncationMarker(output, retainedKeys);
      break;
    }
    retainedKeys.push(key);
  }
  return output;
}

function sanitizePinoRecord(line: Buffer): Buffer | undefined {
  if (line.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

  const record = parsed as Record<string, unknown>;
  const output = plainObject();
  if (typeof record.level === "number" && Number.isFinite(record.level))
    output.level = record.level;
  if (typeof record.time === "number" && Number.isFinite(record.time)) output.time = record.time;
  if (typeof record.pid === "number" && Number.isFinite(record.pid)) output.pid = record.pid;
  if (typeof record.hostname === "string") output.hostname = sanitizeLogString(record.hostname);
  if (typeof record.name === "string") output.name = sanitizeLogString(record.name);
  output.msg = typeof record.msg === "string" ? sanitizeLogString(record.msg) : "";

  const metadata = sanitizeCompleteRecordMetadata(record);
  for (const [key, value] of Object.entries(metadata)) output[key] = value;
  return Buffer.from(`${JSON.stringify(output)}\n`, "utf8");
}

const SAFE_RECORD_FALLBACK = Buffer.from(
  `${JSON.stringify({
    level: 40,
    name: "platform",
    msg: "Log record rejected by safe boundary",
    metadata: { truncated: INVALID_OR_OVERSIZED_RECORD },
  })}\n`,
  "utf8",
);

export interface SafePinoDestination {
  write(chunk: Uint8Array | string): unknown;
}

export function createSafePinoRecordStream(destinations: readonly SafePinoDestination[]): Writable {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let discardingOversizedRecord = false;

  const forward = (line: Buffer): void => {
    for (const destination of destinations) destination.write(line);
  };
  const rejectRecord = (): void => forward(SAFE_RECORD_FALLBACK);
  const acceptRecord = (): void => {
    const safe = sanitizePinoRecord(Buffer.concat(pending, pendingBytes));
    pending = [];
    pendingBytes = 0;
    if (safe) forward(safe);
    else rejectRecord();
  };

  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        let offset = 0;
        while (offset < chunk.length) {
          const newline = chunk.indexOf(0x0a, offset);
          if (discardingOversizedRecord) {
            if (newline === -1) {
              callback();
              return;
            }
            discardingOversizedRecord = false;
            offset = newline + 1;
            continue;
          }

          const end = newline === -1 ? chunk.length : newline;
          const segmentLength = end - offset;
          if (segmentLength > MAX_PINO_RECORD_INPUT_BYTES - pendingBytes) {
            pending = [];
            pendingBytes = 0;
            rejectRecord();
            if (newline === -1) {
              discardingOversizedRecord = true;
              callback();
              return;
            }
            offset = newline + 1;
            continue;
          }

          if (segmentLength > 0) {
            pending.push(Buffer.from(chunk.subarray(offset, end)));
            pendingBytes += segmentLength;
          }
          if (newline === -1) {
            callback();
            return;
          }
          if (pendingBytes > 0) acceptRecord();
          offset = newline + 1;
        }
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    final(callback) {
      try {
        if (!discardingOversizedRecord && pendingBytes > 0) acceptRecord();
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

interface ProtectedLoggerState {
  readonly bindingBytes: number;
  readonly saturated: boolean;
}

const protectedLoggers = new WeakSet<object>();

type PinoChild = (bindings: Record<string, unknown>, options?: unknown) => Logger;

// A Pino child inherits from its parent, so reading `logger.child` on a child
// resolves to the parent's guard rather than Pino's own implementation. Wrapping
// that guard again would keep calling it with the parent as the receiver, and
// every grandchild would then replace its parent's bindings instead of
// extending them. Resolve back to the pristine implementation instead.
const guardedChildren = new WeakMap<object, PinoChild>();

function pristineChild(logger: Logger): PinoChild {
  const current = logger.child as unknown as PinoChild;
  return guardedChildren.get(current) ?? current;
}

function admittedChildBindings(
  bindings: unknown,
  state: ProtectedLoggerState,
): { bindings: Record<string, unknown>; state: ProtectedLoggerState } {
  const sanitized = sanitizeLogMetadata(bindings);
  const encodedBytes = serializedBytes(sanitized);
  const contentBytes = Math.max(0, encodedBytes - 2);
  const separatorBytes = state.bindingBytes > 2 && contentBytes > 0 ? 1 : 0;
  if (
    !state.saturated &&
    state.bindingBytes + separatorBytes + contentBytes <= MAX_SERIALIZED_BYTES
  ) {
    return {
      bindings: ownedObject(sanitized),
      state: {
        bindingBytes: state.bindingBytes + separatorBytes + contentBytes,
        saturated: false,
      },
    };
  }

  if (!state.saturated) {
    const marker = plainObject();
    marker.metadataTruncated = METADATA_TOO_LARGE;
    const markerContentBytes = Math.max(0, serializedBytes(marker) - 2);
    const markerSeparator = state.bindingBytes > 2 ? 1 : 0;
    if (state.bindingBytes + markerSeparator + markerContentBytes <= MAX_SERIALIZED_BYTES) {
      return {
        bindings: ownedObject(marker),
        state: {
          bindingBytes: state.bindingBytes + markerSeparator + markerContentBytes,
          saturated: true,
        },
      };
    }
  }

  return { bindings: ownedObject(plainObject()), state: { ...state, saturated: true } };
}

export function protectPinoLogger<LoggerType extends Logger>(
  logger: LoggerType,
  state: ProtectedLoggerState = { bindingBytes: 2, saturated: false },
): LoggerType {
  if (protectedLoggers.has(logger)) return logger;
  const rawChild = pristineChild(logger);
  const safeChild = (bindings: unknown, options?: unknown): Logger => {
    const admitted = admittedChildBindings(bindings, state);
    const child = rawChild.call(logger, admitted.bindings, options);
    return protectPinoLogger(child, admitted.state);
  };
  guardedChildren.set(safeChild, rawChild);
  Object.defineProperty(logger, "child", {
    configurable: true,
    value: safeChild,
    writable: true,
  });
  protectedLoggers.add(logger);
  return logger;
}

const PINO_REDACTION_PATHS = [
  "req",
  "request",
  "raw",
  "url",
  "headers",
  "body",
  "query",
  "cookie",
  "authorization",
  "proxyAuthorization",
  "forwardedClientCert",
  "*.raw",
  "*.url",
  "*.headers",
  "*.body",
  "*.query",
  "*.*.raw",
  "*.*.url",
  "*.*.headers",
  "*.*.body",
  "*.*.query",
] as const;

export function createSafePinoOptions(level: string): LoggerOptions {
  return {
    level,
    depthLimit: MAX_DEPTH,
    edgeLimit: MAX_CONTAINER_ITEMS,
    redact: {
      paths: [...PINO_REDACTION_PATHS],
      censor: REDACTED,
    },
    formatters: {
      bindings(bindings) {
        return ownedObject(sanitizeLogMetadata(bindings));
      },
    },
    serializers: {
      req: () => "[redacted-request]",
      request: () => "[redacted-request]",
      res: () => "[redacted-response]",
      err: (error) => sanitizeLogValue(error),
    },
    hooks: {
      logMethod(args, method) {
        method.apply(this, sanitizedPinoArguments(args));
      },
    },
  };
}
