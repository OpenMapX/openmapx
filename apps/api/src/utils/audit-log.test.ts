import type { FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appLogger } from "../services/app-logger.js";
import { summarizeExternalUrl } from "./safe-log-fields.js";

// Hoisted so the vi.mock factory (itself hoisted) can reference the spies.
const h = vi.hoisted(() => {
  const valuesMock = vi.fn();
  const insertMock = vi.fn(() => ({ values: valuesMock }));
  return { valuesMock, insertMock };
});

vi.mock("../db/index.js", () => ({ db: { insert: h.insertMock } }));
vi.mock("../db/schema.js", () => ({ adminAuditLog: {} }));

import { writeAuditLog } from "./audit-log.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const PRIVATE_URL =
  "https://fixture-user:fixture-pass@sources.example.test/private/catalog.json?token=fixture-audit-token#fixture-fragment";

function fakeReq(ip: string, userAgent?: string): FastifyRequest {
  return {
    ip,
    headers: userAgent ? { "user-agent": userAgent } : {},
  } as unknown as FastifyRequest;
}

describe("writeAuditLog", () => {
  it("inserts a normal entry with the request ip and user-agent", async () => {
    await writeAuditLog({
      actorId: "admin-1",
      targetId: "u-2",
      targetType: "user",
      action: "user.ban",
      details: { reason: "spam" },
      request: fakeReq("203.0.113.5", "vitest-ua"),
    });

    expect(h.insertMock).toHaveBeenCalledTimes(1);
    expect(h.valuesMock).toHaveBeenCalledTimes(1);
    const values = h.valuesMock.mock.calls[0][0] as Record<string, unknown>;
    expect(values).toMatchObject({
      actorId: "admin-1",
      action: "user.ban",
      targetId: "u-2",
      ipAddress: "203.0.113.5",
      userAgent: "vitest-ua",
    });
    expect(typeof values.id).toBe("string");
  });

  it("maps the loopback sentinel actor to null with a tagged user-agent", async () => {
    await writeAuditLog({ actorId: "loopback", action: "user.role.change" });

    const values = h.valuesMock.mock.calls[0][0] as Record<string, unknown>;
    expect(values.actorId).toBeNull();
    expect(values.userAgent).toBe("unknown (loopback)");
  });

  it("sanitizes an extension label, nested credentials, and hostile values before persistence", async () => {
    let getterCalls = 0;
    let proxyTrapCalls = 0;
    const hostile = {} as Record<string, unknown>;
    Object.defineProperty(hostile, "value", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return PRIVATE_URL;
      },
    });
    const proxy = new Proxy(
      { privateValue: PRIVATE_URL },
      {
        getPrototypeOf(target) {
          proxyTrapCalls += 1;
          return Reflect.getPrototypeOf(target);
        },
        ownKeys(target) {
          proxyTrapCalls += 1;
          return Reflect.ownKeys(target);
        },
      },
    );

    await writeAuditLog({
      actorId: "admin-1",
      action: "extension.add_source",
      details: {
        label: PRIVATE_URL,
        nested: { authorization: "Bearer fixture-audit-bearer", safe: "kept" },
        hostile,
        proxy,
      },
    });

    const values = h.valuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(values.details).toEqual({
      label: "[redacted-url]",
      nested: { authorization: "[redacted]", safe: "kept" },
      hostile: { value: "[redacted]" },
      proxy: "[redacted]",
    });
    expect(getterCalls).toBe(0);
    expect(proxyTrapCalls).toBe(0);
    expect(JSON.stringify(values.details)).not.toMatch(
      /fixture-user|fixture-pass|fixture-audit-token|fixture-audit-bearer|private\/catalog/,
    );
  });

  it("preserves an explicitly branded URL summary at the durable boundary", async () => {
    await writeAuditLog({
      actorId: "admin-1",
      action: "extension.install",
      details: { sourceUrl: summarizeExternalUrl(PRIVATE_URL), safe: "kept" },
    });

    const values = h.valuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(values.details).toEqual({
      sourceUrl: {
        host: "sources.example.test",
        digest: "de65b237f14e766407a337b6cd40bd6c",
      },
      safe: "kept",
    });
    expect(JSON.stringify(values.details)).not.toContain("fixture-audit-token");
  });

  it("replaces oversized audit details with one deterministic bounded value", async () => {
    await writeAuditLog({
      actorId: "admin-1",
      action: "extension.add_source",
      details: Object.fromEntries(
        Array.from({ length: 50 }, (_, index) => [`field-${index}`, "x".repeat(2_048)]),
      ),
    });

    const values = h.valuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(values.details).toEqual({ truncated: "[metadata exceeds 16 KiB]" });
    expect(Buffer.byteLength(JSON.stringify(values.details), "utf8")).toBeLessThanOrEqual(
      16 * 1_024,
    );
  });

  it("swallows DB errors so the main operation is never broken", async () => {
    h.insertMock.mockImplementationOnce(() => {
      throw new TypeError(`db down at ${PRIVATE_URL} Bearer fixture-db-token`);
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const before = appLogger.getEntries({ source: "audit-log" }).total;
    await expect(
      writeAuditLog({ actorId: "admin-1", action: "user.ban" }),
    ).resolves.toBeUndefined();
    const result = appLogger.getEntries({ source: "audit-log" });

    expect(consoleSpy).not.toHaveBeenCalled();
    expect(result.total).toBe(before + 1);
    expect(result.entries[0]).toMatchObject({
      level: "error",
      source: "audit-log",
      msg: "Audit log persistence failed",
      metadata: { errorClass: "TypeError" },
    });
    expect(JSON.stringify(result.entries[0])).not.toMatch(
      /fixture-user|fixture-pass|fixture-audit-token|fixture-db-token|private\/catalog/,
    );
  });
});
