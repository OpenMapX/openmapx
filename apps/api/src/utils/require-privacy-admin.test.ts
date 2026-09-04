import type { FastifyRequest } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../auth.js", () => ({ auth: { api: { getSession: vi.fn() } } }));

import { auth } from "../auth.js";
import { requirePrivacyAdmin } from "./require-privacy-admin.js";

const getSession = vi.mocked(auth.api.getSession);
const request = {
  socket: { remoteAddress: "203.0.113.4" },
  headers: {},
} as unknown as FastifyRequest;

beforeEach(() => getSession.mockReset());

describe("requirePrivacyAdmin", () => {
  it("rejects unauthenticated callers", async () => {
    getSession.mockResolvedValue(null as never);
    await expect(requirePrivacyAdmin(request)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("accepts privacy_admin and stores an attributable session", async () => {
    const session = { user: { id: "privacy-1", role: "privacy_admin" }, session: { id: "s1" } };
    getSession.mockResolvedValue(session as never);
    await expect(requirePrivacyAdmin(request)).resolves.toBe(session);
  });

  it("accepts full admins", async () => {
    const session = { user: { id: "admin-1", role: "admin" }, session: { id: "s1" } };
    getSession.mockResolvedValue(session as never);
    await expect(requirePrivacyAdmin(request)).resolves.toBe(session);
  });

  it("rejects ordinary users and synthetic loopback sessions", async () => {
    getSession.mockResolvedValue({ user: { id: "user-1", role: "user" } } as never);
    await expect(requirePrivacyAdmin(request)).rejects.toMatchObject({ statusCode: 403 });
    getSession.mockResolvedValue({ user: { id: "loopback", role: "admin" } } as never);
    await expect(requirePrivacyAdmin(request)).rejects.toMatchObject({ statusCode: 403 });
  });
});
