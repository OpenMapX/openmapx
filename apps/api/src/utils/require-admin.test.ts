import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../auth.js", () => ({
  auth: { api: { getSession: vi.fn() } },
}));

import { auth } from "../auth.js";
import { requireAdmin } from "./require-admin.js";

const getSession = vi.mocked(auth.api.getSession);

interface FakeReqParts {
  remoteAddress?: string;
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
}

function fakeRequest(parts: FakeReqParts): FastifyRequest {
  return {
    socket: { remoteAddress: parts.remoteAddress },
    headers: parts.headers ?? {},
    ip: parts.ip ?? parts.remoteAddress ?? "",
  } as unknown as FastifyRequest;
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("OPENMAPX_LOCAL_ADMIN_TOKEN", "");
  vi.stubEnv("OPENMAPX_DISABLE_LOCALHOST_AUTH", "");
  getSession.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("requireAdmin — session enforcement", () => {
  it("rejects with 401 when there is no session and the peer is not loopback", async () => {
    getSession.mockResolvedValue(null as never);
    await expect(requireAdmin(fakeRequest({ remoteAddress: "203.0.113.9" }))).rejects.toMatchObject(
      { statusCode: 401 },
    );
  });

  it("rejects with 403 when the session role is not admin", async () => {
    getSession.mockResolvedValue({ user: { role: "user" } } as never);
    await expect(requireAdmin(fakeRequest({ remoteAddress: "203.0.113.9" }))).rejects.toMatchObject(
      { statusCode: 403 },
    );
  });

  it("resolves with the session for an admin role", async () => {
    const session = { user: { role: "admin", id: "admin-1" } };
    getSession.mockResolvedValue(session as never);
    await expect(requireAdmin(fakeRequest({ remoteAddress: "203.0.113.9" }))).resolves.toBe(
      session,
    );
  });
});

describe("requireAdmin — loopback short-circuit", () => {
  it("grants a synthetic loopback session when the header is present and no token is configured", async () => {
    const result = await requireAdmin(
      fakeRequest({ remoteAddress: "127.0.0.1", headers: { "x-openmapx-local-admin": "" } }),
    );
    expect(result.user.id).toBe("loopback");
    expect(getSession).not.toHaveBeenCalled();
  });

  it("falls through to getSession when the loopback header is absent (CSRF defense)", async () => {
    getSession.mockResolvedValue(null as never);
    await expect(
      requireAdmin(fakeRequest({ remoteAddress: "127.0.0.1", headers: {} })),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(getSession).toHaveBeenCalled();
  });

  it("does not trust a forged X-Forwarded-For claiming loopback", async () => {
    getSession.mockResolvedValue(null as never);
    await expect(
      requireAdmin(
        fakeRequest({
          remoteAddress: "203.0.113.9",
          ip: "127.0.0.1",
          headers: { "x-forwarded-for": "127.0.0.1", "x-openmapx-local-admin": "" },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(getSession).toHaveBeenCalled();
  });
});

describe("requireAdmin — loopback token configured", () => {
  beforeEach(() => {
    vi.stubEnv("OPENMAPX_LOCAL_ADMIN_TOKEN", "test-local-admin-token-fake");
  });

  it("grants a loopback session when the header value matches the token", async () => {
    const result = await requireAdmin(
      fakeRequest({
        remoteAddress: "127.0.0.1",
        headers: { "x-openmapx-local-admin": "test-local-admin-token-fake" },
      }),
    );
    expect(result.user.id).toBe("loopback");
    expect(getSession).not.toHaveBeenCalled();
  });

  it("falls through to getSession when the header value is wrong", async () => {
    getSession.mockResolvedValue(null as never);
    await expect(
      requireAdmin(
        fakeRequest({
          remoteAddress: "127.0.0.1",
          headers: { "x-openmapx-local-admin": "wrong-fake" },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(getSession).toHaveBeenCalled();
  });
});

describe("requireAdmin — loopback dev-default guards", () => {
  it("denies the empty-header dev default in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    getSession.mockResolvedValue(null as never);
    await expect(
      requireAdmin(
        fakeRequest({ remoteAddress: "127.0.0.1", headers: { "x-openmapx-local-admin": "" } }),
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(getSession).toHaveBeenCalled();
  });

  it("is disabled entirely by OPENMAPX_DISABLE_LOCALHOST_AUTH=1", async () => {
    vi.stubEnv("OPENMAPX_DISABLE_LOCALHOST_AUTH", "1");
    getSession.mockResolvedValue(null as never);
    await expect(
      requireAdmin(
        fakeRequest({ remoteAddress: "127.0.0.1", headers: { "x-openmapx-local-admin": "" } }),
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(getSession).toHaveBeenCalled();
  });
});
