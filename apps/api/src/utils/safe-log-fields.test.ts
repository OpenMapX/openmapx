import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { createIntegrationLogger } from "./integration-logger.js";
import * as safeLogFields from "./safe-log-fields.js";
import {
  createSafePinoOptions,
  safeErrorClass,
  sanitizeLogMetadata,
  sanitizeLogString,
  summarizeExternalUrl,
} from "./safe-log-fields.js";

const PRIVATE_URL =
  "https://fixture-user:fixture-pass@Images.Example.test/sensitive/path/share-id?token=fixture-token#fixture-fragment";
const PRIVATE_URL_DIGEST = "dd6b78601cc82d6c5298d884031be008";
const PRIVATE_MARKERS = [
  "fixture-user",
  "fixture-pass",
  "sensitive/path",
  "share-id",
  "fixture-token",
  "fixture-fragment",
];

function observable(value: unknown): string {
  return JSON.stringify(value);
}

function capturePino() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return {
    chunks,
    logger: pino(createSafePinoOptions("info"), stream),
    records: () =>
      chunks
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
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

async function writeChunk(stream: WritableTarget, value: string): Promise<void> {
  stream.write(value);
  await Promise.resolve();
}

function captureStream(): { chunks: string[]; stream: Writable } {
  const chunks: string[] = [];
  return {
    chunks,
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    }),
  };
}

describe("summarizeExternalUrl", () => {
  it("retains only a canonical host and a fixed digest prefix", () => {
    const summary = summarizeExternalUrl(PRIVATE_URL);

    expect(summary).toEqual({
      host: "images.example.test",
      digest: PRIVATE_URL_DIGEST,
    });
    expect(Object.isFrozen(summary)).toBe(true);
    for (const marker of PRIVATE_MARKERS) expect(observable(summary)).not.toContain(marker);
  });

  it("uses an invalid host without exposing an unparseable source", () => {
    const summary = summarizeExternalUrl("not a URL with fixture-token");

    expect(summary.host).toBe("invalid");
    expect(summary.digest).toMatch(/^[a-f0-9]{32}$/);
    expect(observable(summary)).not.toContain("fixture-token");
  });
});

describe("sanitizeLogMetadata", () => {
  it("redacts sensitive keys case-insensitively at every nested level", () => {
    const sanitized = sanitizeLogMetadata({
      safe: "kept",
      nested: {
        Authorization: "Bearer fixture-auth",
        COOKIE: "session=fixture-cookie",
        accessToken: "fixture-access-token",
        PASSWORD: "fixture-password",
        clientSecret: "fixture-secret",
        apiKey: "fixture-api-key",
        credentials: "fixture-credential",
        sessionId: "fixture-session",
        userId: "fixture-user",
        email: "person@example.test",
        sourceURL: PRIVATE_URL,
      },
    });

    expect(sanitized.safe).toBe("kept");
    expect(sanitized.nested).toEqual({
      Authorization: "[redacted]",
      COOKIE: "[redacted]",
      accessToken: "[redacted]",
      PASSWORD: "[redacted]",
      clientSecret: "[redacted]",
      apiKey: "[redacted]",
      credentials: "[redacted]",
      sessionId: "[redacted]",
      userId: "[redacted]",
      email: "[redacted]",
      sourceURL: "[redacted]",
    });
    expect(Object.getPrototypeOf(sanitized)).toBeNull();
    expect(Object.getPrototypeOf(sanitized.nested)).toBeNull();
  });

  it("allows a URL-key summary only when it is the exact branded object", () => {
    const branded = summarizeExternalUrl(PRIVATE_URL);
    const forged = { host: branded.host, digest: branded.digest };

    expect(sanitizeLogMetadata({ sourceUrl: branded })).toEqual({
      sourceUrl: { host: "images.example.test", digest: PRIVATE_URL_DIGEST },
    });
    expect(sanitizeLogMetadata({ sourceUrl: forged })).toEqual({
      sourceUrl: "[redacted]",
    });
    expect(sanitizeLogMetadata({ authorization: branded })).toEqual({
      authorization: "[redacted]",
    });
  });

  it("caps depth, items per container, string length, and final serialized bytes", () => {
    const array = Array.from({ length: 80 }, (_, index) => `item-${index}`);
    const object = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [`field-${index}`, `value-${index}`]),
    );
    const deep = { one: { two: { three: { four: { five: "too deep" } } } } };
    const oversized = Object.fromEntries(
      Array.from({ length: 50 }, (_, index) => [`large-${index}`, "x".repeat(2_048)]),
    );

    const sanitized = sanitizeLogMetadata({
      array,
      object,
      deep,
      long: "y".repeat(3_000),
    });
    const oversizedSanitized = sanitizeLogMetadata(oversized);

    expect((sanitized.array as unknown[]).length).toBeLessThanOrEqual(50);
    expect(Object.keys(sanitized.object as object).length).toBeLessThanOrEqual(50);
    expect(observable(sanitized.deep)).not.toContain("too deep");
    expect((sanitized.long as string).length).toBeLessThanOrEqual(2_048);
    expect(Buffer.byteLength(observable(sanitized), "utf8")).toBeLessThanOrEqual(16 * 1_024);
    expect(Buffer.byteLength(observable(oversizedSanitized), "utf8")).toBeLessThanOrEqual(
      16 * 1_024,
    );
    expect(oversizedSanitized).toEqual({ truncated: "[metadata exceeds 16 KiB]" });
  });

  it("handles cycles and accessors without invoking user code", () => {
    let getterCalls = 0;
    let toJsonCalls = 0;
    const hostile: Record<string, unknown> = { safe: "kept" };
    Object.defineProperty(hostile, "computed", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return PRIVATE_URL;
      },
    });
    Object.defineProperty(hostile, "toJSON", {
      enumerable: true,
      value() {
        toJsonCalls += 1;
        return { url: PRIVATE_URL };
      },
    });
    hostile.circular = hostile;
    const sanitized = sanitizeLogMetadata({ hostile });

    expect(getterCalls).toBe(0);
    expect(toJsonCalls).toBe(0);
    expect(observable(sanitized)).not.toContain(PRIVATE_URL);
    expect(observable(sanitized)).toContain("[circular]");
  });

  it("redacts every proxy before any trap can run", () => {
    const calls = {
      getPrototypeOf: 0,
      ownKeys: 0,
      getOwnPropertyDescriptor: 0,
      get: 0,
      toJSON: 0,
      customInspect: 0,
    };
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
        if (property === "toJSON") calls.toJSON += 1;
        else if (property === Symbol.for("nodejs.util.inspect.custom")) calls.customInspect += 1;
        else calls.get += 1;
        return Reflect.get(target, property, receiver);
      },
    };
    const ordinaryProxy = new Proxy({ safe: "must-not-be-read" }, handler);
    const arrayProxy = new Proxy(["must-not-be-read"], handler);
    const errorProxy = new Proxy(new Error(PRIVATE_URL), handler);
    const { proxy: revokedProxy, revoke } = Proxy.revocable({ safe: "ignored" }, {});
    revoke();

    expect(sanitizeLogMetadata(ordinaryProxy)).toEqual({ value: "[redacted]" });
    expect(
      sanitizeLogMetadata({
        ordinaryProxy,
        arrayProxy,
        errorProxy,
        nested: { ordinaryProxy },
        revokedProxy,
      }),
    ).toEqual({
      ordinaryProxy: "[redacted]",
      arrayProxy: "[redacted]",
      errorProxy: "[redacted]",
      nested: { ordinaryProxy: "[redacted]" },
      revokedProxy: "[redacted]",
    });
    expect(safeErrorClass(errorProxy)).toBe("NonError");
    expect(calls).toEqual({
      getPrototypeOf: 0,
      ownKeys: 0,
      getOwnPropertyDescriptor: 0,
      get: 0,
      toJSON: 0,
      customInspect: 0,
    });
  });

  it("cannot be prototype-polluted by metadata keys", () => {
    const input = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(input, "__proto__", {
      enumerable: true,
      value: { polluted: true },
    });
    Object.defineProperty(input, "constructor", {
      enumerable: true,
      value: { prototype: { polluted: true } },
    });

    const sanitized = sanitizeLogMetadata(input);

    expect(Object.getPrototypeOf(sanitized)).toBeNull();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(observable(sanitized)).not.toContain("polluted");
  });
});

describe("log string and Error sanitization", () => {
  it("redacts email addresses from free-form log messages", () => {
    expect(sanitizeLogString("delivery failed for person@example.test")).toBe(
      "delivery failed for [redacted-email]",
    );
  });

  it("removes ordinary URL and bearer patterns and caps the result", () => {
    const sanitized = sanitizeLogString(
      `fetch ${PRIVATE_URL} failed with Bearer fixture-bearer-token ${"z".repeat(3_000)}`,
    );

    expect(sanitized).toContain("[redacted-url]");
    expect(sanitized).toContain("Bearer [redacted]");
    expect(sanitized.length).toBeLessThanOrEqual(2_048);
    for (const marker of [...PRIVATE_MARKERS, "fixture-bearer-token"])
      expect(sanitized).not.toContain(marker);
  });

  it("caps a multibyte message by both characters and UTF-8 bytes", () => {
    const sanitized = sanitizeLogString("😀".repeat(2_048));

    expect(Array.from(sanitized).length).toBeLessThanOrEqual(2_048);
    expect(Buffer.byteLength(sanitized, "utf8")).toBeLessThanOrEqual(2_048);
  });

  it("sanitizes Error name, message, and stack without trusting accessors", () => {
    const error = new Error(`upstream ${PRIVATE_URL} Bearer fixture-error-token`);
    error.name = "FetchError";
    error.stack = `FetchError: ${PRIVATE_URL}\n    at fixture (${PRIVATE_URL})`;

    const sanitized = sanitizeLogMetadata({ error });
    const output = observable(sanitized);

    expect(output).toContain("FetchError");
    expect(output).toContain("[redacted-url]");
    for (const marker of [...PRIVATE_MARKERS, "fixture-error-token"])
      expect(output).not.toContain(marker);
  });

  it("returns only a bounded class label for errors and hostile values", () => {
    expect(safeErrorClass(Object.assign(new Error("ignored"), { name: "UpstreamTimeout" }))).toBe(
      "UpstreamTimeout",
    );
    expect(safeErrorClass({ name: PRIVATE_URL })).toBe("NonError");
    expect(safeErrorClass("Bearer fixture-error-token")).toBe("NonError");
  });
});

describe("Pino defense-in-depth", () => {
  it("sanitizes child bindings, structured fields, message arguments, and errors before output", () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const logger = pino(createSafePinoOptions("info"), stream).child({
      url: PRIVATE_URL,
      authorization: "Bearer fixture-child-token",
      safeChild: "kept",
    });
    const error = new Error(`failed ${PRIVATE_URL} Bearer fixture-error-token`);

    logger.warn(
      {
        cookie: "session=fixture-cookie",
        nested: { apiKey: "fixture-api-key", safe: "kept" },
        err: error,
      },
      "request %s",
      PRIVATE_URL,
    );

    const output = chunks.join("");
    expect(output).toContain("safeChild");
    expect(output).toContain("kept");
    expect(output).toContain("[redacted]");
    expect(output).toContain("[redacted-url]");
    for (const marker of [
      ...PRIVATE_MARKERS,
      "fixture-child-token",
      "fixture-cookie",
      "fixture-api-key",
      "fixture-error-token",
    ]) {
      expect(output).not.toContain(marker);
    }
  });

  it("never invokes a getter while preparing a log record", () => {
    let getterCalls = 0;
    const hostile = {} as Record<string, unknown>;
    Object.defineProperty(hostile, "value", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return PRIVATE_URL;
      },
    });
    const stream = new Writable({ write: (_chunk, _encoding, callback) => callback() });
    const logger = pino(createSafePinoOptions("info"), stream);

    logger.info({ hostile }, "hostile metadata");

    expect(getterCalls).toBe(0);
  });

  it("redacts root and nested proxies before Pino can invoke their traps", () => {
    const calls = {
      getPrototypeOf: 0,
      ownKeys: 0,
      getOwnPropertyDescriptor: 0,
      get: 0,
      toJSON: 0,
      customInspect: 0,
    };
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
        if (property === "toJSON") calls.toJSON += 1;
        else if (property === Symbol.for("nodejs.util.inspect.custom")) calls.customInspect += 1;
        else calls.get += 1;
        return Reflect.get(target, property, receiver);
      },
    };
    const rootProxy = new Proxy({ privateValue: PRIVATE_URL }, handler);
    const nestedProxy = new Proxy([PRIVATE_URL], handler);
    const errorProxy = new Proxy(new Error(PRIVATE_URL), handler);
    const capture = capturePino();

    capture.logger.info(rootProxy);
    capture.logger.warn({ nestedProxy, errorProxy }, "proxy metadata");
    capture.logger.error("proxy %s", rootProxy);

    expect(calls).toEqual({
      getPrototypeOf: 0,
      ownKeys: 0,
      getOwnPropertyDescriptor: 0,
      get: 0,
      toJSON: 0,
      customInspect: 0,
    });
    expect(capture.records()[0]?.msg).toBe("[redacted]");
    expect(capture.records()[1]).toMatchObject({
      nestedProxy: "[redacted]",
      errorProxy: "[redacted]",
    });
    expect(capture.chunks.join("")).not.toContain(PRIVATE_URL);
  });

  it("sanitizes the fully interpolated message while preserving structured fields", () => {
    const capture = capturePino();
    const error = new TypeError(`failed at ${PRIVATE_URL} with Bearer fixture-error-token`);

    capture.logger.warn(
      { safe: "kept", token: "fixture-binding-token", err: error },
      "%s%s %s%s %j",
      "Bearer ",
      "fixture-split-bearer-token",
      "https://",
      "fixture-user:fixture-pass@example.test/private?token=fixture-split-url-token",
      { nestedUrl: PRIVATE_URL, safeJson: "kept-json" },
    );

    const [record] = capture.records();
    expect(record).toMatchObject({
      safe: "kept",
      token: "[redacted]",
      err: { name: "TypeError" },
    });
    expect(record.msg).toContain("Bearer [redacted]");
    expect(record.msg).toContain("[redacted-url]");
    expect(record.msg).toContain("kept-json");
    expect((record.msg as string).length).toBeLessThanOrEqual(2_048);
    expect(Buffer.byteLength(JSON.stringify(record), "utf8")).toBeLessThanOrEqual(16 * 1_024);
    expect(capture.chunks.join("")).not.toMatch(
      /fixture-split-bearer-token|fixture-split-url-token|fixture-binding-token|fixture-error-token|fixture-user|fixture-pass|private\?/,
    );
  });

  it("preserves URL placeholders until final interpolation and then redacts the complete URL", () => {
    const capture = capturePino();

    capture.logger.warn("https://example.test/private?token=%s", "fixture-placeholder-secret");

    const [record] = capture.records();
    expect(record?.msg).toBe("[redacted-url]");
    expect(capture.chunks.join("")).not.toContain("fixture-placeholder-secret");
  });

  it("formats only sanitizer-owned data and bounds many individually valid fragments", () => {
    const capture = capturePino();
    let toStringCalls = 0;
    let toJsonCalls = 0;
    let inspectCalls = 0;
    const hostile = { safe: "kept" } as Record<PropertyKey, unknown>;
    Object.defineProperties(hostile, {
      toString: {
        value() {
          toStringCalls += 1;
          return PRIVATE_URL;
        },
      },
      toJSON: {
        value() {
          toJsonCalls += 1;
          return PRIVATE_URL;
        },
      },
      [Symbol.for("nodejs.util.inspect.custom")]: {
        value() {
          inspectCalls += 1;
          return PRIVATE_URL;
        },
      },
    });
    const fragments = Array.from({ length: 100 }, () => "x".repeat(2_048));

    capture.logger.info("hostile %s %j", hostile, hostile);
    (capture.logger as unknown as { info(...args: unknown[]): void }).info(
      "%s".repeat(fragments.length),
      ...fragments,
    );

    const records = capture.records();
    expect(records[0]?.msg).toContain("kept");
    expect(toStringCalls).toBe(0);
    expect(toJsonCalls).toBe(0);
    expect(inspectCalls).toBe(0);
    expect((records[1]?.msg as string).length).toBeLessThanOrEqual(2_048);
    expect(Buffer.byteLength(JSON.stringify(records[1]), "utf8")).toBeLessThanOrEqual(16 * 1_024);
  });

  it("sanitizes split interpolation forwarded by the integration logger", () => {
    const capture = capturePino();
    const integrationLog = createIntegrationLogger("fixture-integration", {
      log: capture.logger,
    } as never);

    integrationLog.warn(
      "%s%s",
      "Bearer ",
      "fixture-integration-token",
      new Error(`upstream ${PRIVATE_URL}`),
    );

    const [record] = capture.records();
    expect(record).toMatchObject({ integration: "fixture-integration", err: { name: "Error" } });
    expect(record.msg).toBe("Bearer [redacted]");
    expect(capture.chunks.join("")).not.toMatch(
      /fixture-integration-token|fixture-user|fixture-pass/,
    );
  });

  it("rejects integration logger Proxy arguments before Error detection can invoke traps", () => {
    let getPrototypeOfCalls = 0;
    const proxy = new Proxy(
      { safe: "must-not-be-read" },
      {
        getPrototypeOf(target) {
          getPrototypeOfCalls += 1;
          return Reflect.getPrototypeOf(target);
        },
      },
    );
    const warn = vi.fn();
    const integrationLog = createIntegrationLogger("fixture-integration", {
      log: { warn } as never,
    } as never);

    integrationLog.warn("proxy metadata %s", proxy);

    expect(getPrototypeOfCalls).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("sanitizes child bindings before Pino reflection and protects every nested child", () => {
    const capture = captureStream();
    let getterCalls = 0;
    let toJsonCalls = 0;
    const hostile = {} as Record<string, unknown>;
    Object.defineProperty(hostile, "value", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return PRIVATE_URL;
      },
    });
    Object.defineProperty(hostile, "toJSON", {
      value() {
        toJsonCalls += 1;
        return { safeChild: PRIVATE_URL };
      },
    });
    const trapCalls = {
      getPrototypeOf: 0,
      ownKeys: 0,
      getOwnPropertyDescriptor: 0,
      get: 0,
    };
    const proxy = new Proxy(
      { safeChild: PRIVATE_URL },
      {
        getPrototypeOf(target) {
          trapCalls.getPrototypeOf += 1;
          return Reflect.getPrototypeOf(target);
        },
        ownKeys(target) {
          trapCalls.ownKeys += 1;
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, property) {
          trapCalls.getOwnPropertyDescriptor += 1;
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
        get(target, property, receiver) {
          trapCalls.get += 1;
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const logger = protectLogger(pino(createSafePinoOptions("info"), capture.stream));

    logger.child({ safeChild: PRIVATE_URL, hostile }).info("ordinary child");
    logger.child({ correlationId: "kept" }).child(proxy).warn("nested proxy child");

    expect(getterCalls).toBe(0);
    expect(toJsonCalls).toBe(0);
    expect(trapCalls).toEqual({
      getPrototypeOf: 0,
      ownKeys: 0,
      getOwnPropertyDescriptor: 0,
      get: 0,
    });
    expect(capture.chunks.join("")).not.toMatch(
      /fixture-user|fixture-pass|fixture-token|private\/share/,
    );
    const records = capture.chunks
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records[0]).toMatchObject({
      safeChild: "[redacted-url]",
      hostile: { value: "[redacted]" },
    });
    expect(records[1]).toMatchObject({ correlationId: "kept", value: "[redacted]" });
  });

  it("bounds cumulative nested child metadata before Pino and at the complete-record boundary", () => {
    const capture = captureStream();
    const destination = createBoundary([capture.stream]);
    let logger = protectLogger(pino(createSafePinoOptions("info"), destination as never)).child({
      correlationId: "kept-correlation",
    });
    for (let index = 0; index < 20; index += 1) {
      logger = logger.child({ [`safeField${index}`]: "x".repeat(2_048) });
    }

    logger.warn({ route: "/api/fixture" }, "bounded child metadata");

    const [record] = capture.chunks
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const { level, time, pid, hostname, name, msg, ...metadata } = record ?? {};
    expect({ level, time, pid, hostname, name, msg }).toMatchObject({
      level: 40,
      msg: "bounded child metadata",
    });
    expect(metadata).toMatchObject({ correlationId: "kept-correlation" });
    expect(Buffer.byteLength(JSON.stringify(metadata), "utf8")).toBeLessThanOrEqual(16 * 1_024);
  });
});

describe("complete Pino record boundary", () => {
  it("frames partial and multiple lines and sends identical sanitized records to both sinks", async () => {
    const first = captureStream();
    const second = captureStream();
    const destination = createBoundary([first.stream, second.stream]);
    const privateMessage = JSON.stringify({
      level: 40,
      time: 123,
      name: "fixture-source",
      msg: PRIVATE_URL,
      correlationId: "kept-correlation",
    });
    const safeMessage = JSON.stringify({ level: 30, time: 124, msg: "safe second record" });

    await writeChunk(destination, privateMessage.slice(0, 37));
    await writeChunk(destination, `${privateMessage.slice(37)}\n${safeMessage}\n`);

    expect(first.chunks.join("")).toBe(second.chunks.join(""));
    expect(first.chunks.join("")).not.toMatch(
      /fixture-user|fixture-pass|fixture-token|private\/share/,
    );
    const records = first.chunks
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toEqual([
      expect.objectContaining({
        level: 40,
        time: 123,
        name: "fixture-source",
        msg: "[redacted-url]",
        correlationId: "kept-correlation",
      }),
      expect.objectContaining({ level: 30, time: 124, msg: "safe second record" }),
    ]);
  });

  it("emits one static safe fallback for a malformed record and resumes framing", async () => {
    const capture = captureStream();
    const destination = createBoundary([capture.stream]);
    const malformed = `{"msg":"${PRIVATE_URL}" BROKEN}\n`;

    await writeChunk(destination, `${malformed}{"level":30,"time":125,"msg":"safe"}\n`);

    expect(capture.chunks.join("")).not.toMatch(
      /fixture-user|fixture-pass|fixture-token|private\/share/,
    );
    const records = capture.chunks
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      level: 40,
      name: "platform",
      msg: "Log record rejected by safe boundary",
      metadata: { truncated: "[invalid-or-oversized-record]" },
    });
    expect(records[1]).toMatchObject({ level: 30, time: 125, msg: "safe" });
  });

  it("caps partial buffering, emits one fallback, discards the oversized tail, and resumes", async () => {
    const capture = captureStream();
    const destination = createBoundary([capture.stream]);

    await writeChunk(destination, `{"msg":"${PRIVATE_URL}${"x".repeat(70_000)}`);
    expect(capture.chunks.join("")).not.toContain(PRIVATE_URL);
    await writeChunk(destination, `"}\n{"level":30,"time":126,"msg":"safe after oversize"}\n`);

    const records = capture.chunks
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      level: 40,
      name: "platform",
      msg: "Log record rejected by safe boundary",
      metadata: { truncated: "[invalid-or-oversized-record]" },
    });
    expect(records[1]).toMatchObject({ level: 30, time: 126, msg: "safe after oversize" });
  });
});
