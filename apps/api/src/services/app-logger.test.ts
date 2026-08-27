import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import * as safeLogFields from "../utils/safe-log-fields.js";
import { createSafePinoOptions } from "../utils/safe-log-fields.js";
import { type AppLogEntry, AppLogger } from "./app-logger.js";

const PRIVATE_URL =
  "https://fixture-user:fixture-pass@logs.example.test/private/share?token=fixture-token#fixture-fragment";
const PRIVATE_MARKERS = [
  "fixture-user",
  "fixture-pass",
  "private/share",
  "fixture-token",
  "fixture-fragment",
  "fixture-cookie",
  "fixture-secret",
];

function stringify(value: unknown): string {
  return JSON.stringify(value);
}

function unsafeMetadata(): Record<string, unknown> {
  return {
    safe: "kept",
    nested: {
      cookie: "session=fixture-cookie",
      clientSecret: "fixture-secret",
      upstream: `failed at ${PRIVATE_URL}`,
    },
  };
}

type WritableTarget = Pick<Writable, "write">;

function createBoundary(destinations: WritableTarget[]): WritableTarget {
  const factory = (
    safeLogFields as unknown as {
      createSafePinoRecordStream?: (targets: WritableTarget[]) => WritableTarget;
    }
  ).createSafePinoRecordStream;
  return factory
    ? factory(destinations)
    : (pino.multistream(destinations.map((stream) => ({ stream }))) as unknown as WritableTarget);
}

function protectLogger<T>(logger: T): T {
  const protect = (
    safeLogFields as unknown as {
      protectPinoLogger?: <LoggerType>(value: LoggerType) => LoggerType;
    }
  ).protectPinoLogger;
  return protect ? protect(logger) : logger;
}

describe("AppLogger sanitization boundary", () => {
  it("stores the same final interpolated message that the console receives", () => {
    const consoleChunks: string[] = [];
    const consoleStream = new Writable({
      write(chunk, _encoding, callback) {
        consoleChunks.push(String(chunk));
        callback();
      },
    });
    const appLogger = new AppLogger({ persist: async () => {} });
    const logger = pino(
      createSafePinoOptions("info"),
      pino.multistream([{ stream: consoleStream }, { stream: appLogger.createPinoStream() }]),
    );

    logger.warn({ safe: "kept" }, "%s%s", "Bearer ", "fixture-shared-boundary-token");

    const consoleRecord = JSON.parse(consoleChunks.join("")) as Record<string, unknown>;
    const [stored] = appLogger.getEntries({}).entries;
    expect(consoleRecord.msg).toBe("Bearer [redacted]");
    expect(stored.msg).toBe(consoleRecord.msg);
    expect(stored.metadata).toMatchObject({ safe: "kept" });
    expect(consoleChunks.join("")).not.toContain("fixture-shared-boundary-token");
    expect(JSON.stringify(stored)).not.toContain("fixture-shared-boundary-token");
  });

  it("gives stdout and AppLogger the same bounded child-aware record", () => {
    const consoleChunks: string[] = [];
    const consoleStream = new Writable({
      write(chunk, _encoding, callback) {
        consoleChunks.push(String(chunk));
        callback();
      },
    });
    const appLogger = new AppLogger({ persist: async () => {} });
    const destination = createBoundary([consoleStream, appLogger.createPinoStream()]);
    let logger = protectLogger(pino(createSafePinoOptions("info"), destination as never)).child({
      correlationId: "kept-correlation",
      safeChild: PRIVATE_URL,
    });
    for (let index = 0; index < 20; index += 1) {
      logger = logger.child({ [`field${index}`]: "x".repeat(2_048) });
    }

    logger.warn(
      { safeStructured: "kept-structured" },
      "https://example.test/private?token=%s",
      "fixture-parity-token",
    );

    const consoleRecord = JSON.parse(consoleChunks.join("")) as Record<string, unknown>;
    const [stored] = appLogger.getEntries({}).entries;
    expect(consoleRecord.msg).toBe("[redacted-url]");
    expect(stored.msg).toBe(consoleRecord.msg);
    expect(consoleRecord).toMatchObject({ correlationId: "kept-correlation" });
    expect(stored.metadata).toMatchObject({ correlationId: "kept-correlation" });
    const { level, time, pid, hostname, name, msg, ...consoleMetadata } = consoleRecord;
    expect({ level, time, pid, hostname, name, msg }).toMatchObject({ level: 40 });
    expect(Buffer.byteLength(JSON.stringify(consoleMetadata), "utf8")).toBeLessThanOrEqual(
      16 * 1_024,
    );
    expect(consoleChunks.join("")).not.toMatch(
      /fixture-user|fixture-pass|fixture-token|fixture-parity-token|private\/share/,
    );
    expect(JSON.stringify(stored)).not.toMatch(
      /fixture-user|fixture-pass|fixture-token|fixture-parity-token|private\/share/,
    );
  });

  it("sanitizes and detaches metadata before placing an entry in the in-memory buffer", () => {
    const logger = new AppLogger();
    const metadata = unsafeMetadata();

    logger.add({
      level: "info",
      source: "fixture",
      msg: `fetch failed at ${PRIVATE_URL}`,
      time: 1,
      metadata,
    });
    (metadata.nested as Record<string, unknown>).safeAfterAdd = PRIVATE_URL;

    const [entry] = logger.getEntries({}).entries;
    const output = stringify(entry);
    expect(entry.msg).toContain("[redacted-url]");
    expect(entry.metadata).toMatchObject({
      safe: "kept",
      nested: {
        cookie: "[redacted]",
        clientSecret: "[redacted]",
        upstream: "failed at [redacted-url]",
      },
    });
    expect(output).not.toContain("safeAfterAdd");
    for (const marker of PRIVATE_MARKERS) expect(output).not.toContain(marker);
  });

  it("sanitizes a warning before the persistence adapter observes it", async () => {
    const persisted: AppLogEntry[] = [];
    const persist = vi.fn(async (entry: AppLogEntry) => {
      persisted.push(entry);
    });
    const logger = new AppLogger({ persist });

    logger.add({
      level: "warn",
      source: "fixture",
      msg: `provider returned ${PRIVATE_URL} with Bearer fixture-bearer-token`,
      time: 2,
      metadata: unsafeMetadata(),
    });

    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
    const output = stringify(persisted[0]);
    expect(output).toContain("[redacted-url]");
    expect(output).toContain("Bearer [redacted]");
    for (const marker of [...PRIVATE_MARKERS, "fixture-bearer-token"])
      expect(output).not.toContain(marker);
  });

  it("does not persist levels below warn", async () => {
    const persist = vi.fn(async (_entry: AppLogEntry) => {});
    const logger = new AppLogger({ persist });

    logger.add({ level: "info", source: "fixture", msg: "safe", time: 3 });
    await Promise.resolve();

    expect(persist).not.toHaveBeenCalled();
  });

  it("sanitizes parsed Pino records before buffering them", async () => {
    const logger = new AppLogger();
    const stream = logger.createPinoStream();
    const rawRecord = JSON.stringify({
      level: 40,
      name: "fixture",
      msg: `failed at ${PRIVATE_URL}`,
      time: 4,
      authorization: "Bearer fixture-bearer-token",
      nested: unsafeMetadata(),
    });

    await new Promise<void>((resolve, reject) => {
      stream.write(`${rawRecord}\n`, (error) => (error ? reject(error) : resolve()));
    });

    const [entry] = logger.getEntries({}).entries;
    const output = stringify(entry);
    expect(output).toContain("[redacted-url]");
    expect(entry.metadata).toMatchObject({ authorization: "[redacted]" });
    for (const marker of [...PRIVATE_MARKERS, "fixture-bearer-token"])
      expect(output).not.toContain(marker);
  });

  it("retains dangerous parsed keys only as owned redacted metadata", async () => {
    const logger = new AppLogger();
    const stream = logger.createPinoStream();
    const rawRecord =
      '{"level":40,"msg":"failed","time":4,"__proto__":{"secret":"fixture-prototype-secret"}}';

    await new Promise<void>((resolve, reject) => {
      stream.write(`${rawRecord}\n`, (error) => (error ? reject(error) : resolve()));
    });

    const [entry] = logger.getEntries({}).entries;
    expect(Object.getOwnPropertyDescriptor(entry.metadata ?? {}, "__proto__")?.value).toBe(
      "[redacted]",
    );
    expect(JSON.stringify(entry)).not.toContain("fixture-prototype-secret");
    expect(({} as { secret?: string }).secret).toBeUndefined();
  });

  it("never invokes metadata accessors in the buffer or persistence path", async () => {
    let getterCalls = 0;
    const metadata = {} as Record<string, unknown>;
    Object.defineProperty(metadata, "computed", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return PRIVATE_URL;
      },
    });
    const persist = vi.fn(async (_entry: AppLogEntry) => {});
    const logger = new AppLogger({ persist });

    logger.add({ level: "error", source: "fixture", msg: "failed", time: 5, metadata });

    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
    expect(getterCalls).toBe(0);
    expect(stringify(logger.getEntries({}).entries)).not.toContain(PRIVATE_URL);
  });

  it("redacts root and nested metadata proxies before any trap at both boundaries", async () => {
    const calls = { getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, get: 0 };
    const handler: ProxyHandler<object> = {
      getPrototypeOf(target) {
        calls.getPrototypeOf += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        calls.ownKeys += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, property) {
        calls.getOwnPropertyDescriptor += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      get(target, property, receiver) {
        calls.get += 1;
        return Reflect.get(target, property, receiver);
      },
    };
    const rootProxy = new Proxy({ privateValue: PRIVATE_URL }, handler);
    const nestedProxy = new Proxy([PRIVATE_URL], handler);
    const persisted: AppLogEntry[] = [];
    const persist = vi.fn(async (entry: AppLogEntry) => {
      persisted.push(entry);
    });
    const logger = new AppLogger({ persist });

    logger.add({
      level: "warn",
      source: "fixture",
      msg: "proxy metadata",
      time: 6,
      metadata: rootProxy as Record<string, unknown>,
    });
    logger.add({
      level: "warn",
      source: "fixture",
      msg: "nested proxy metadata",
      time: 7,
      metadata: { nestedProxy },
    });

    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(2));
    expect(calls).toEqual({ getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, get: 0 });
    expect(logger.getEntries({}).entries.map((entry) => entry.metadata)).toEqual([
      { nestedProxy: "[redacted]" },
      { value: "[redacted]" },
    ]);
    expect(stringify(persisted)).not.toContain(PRIVATE_URL);
  });
});
