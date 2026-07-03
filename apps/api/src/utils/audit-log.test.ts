import type { FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  vi.clearAllMocks();
});

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

  it("swallows DB errors so the main operation is never broken", async () => {
    h.insertMock.mockImplementationOnce(() => {
      throw new Error("db down");
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      writeAuditLog({ actorId: "admin-1", action: "user.ban" }),
    ).resolves.toBeUndefined();
    consoleSpy.mockRestore();
  });
});
