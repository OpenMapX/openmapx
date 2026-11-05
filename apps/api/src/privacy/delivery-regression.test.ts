import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { privacyAdminRoute } from "../routes/privacy-admin.js";
import { privacyRequestsRoute } from "../routes/privacy-requests.js";
import { PrivacyReauthenticationService, REAUTH_COOKIE_NAME } from "./reauthentication.js";

vi.mock("../auth.js", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () => ({
        user: { id: "subject", role: "privacy_admin", twoFactorEnabled: false },
        session: { id: "new-session" },
      })),
    },
  },
}));
vi.mock("../utils/require-auth.js", () => ({
  requireAuthHook: vi.fn(async () => undefined),
  getUserId: () => "subject",
}));
vi.mock("./session-assurance.js", () => ({
  getSessionAuthAssurance: vi.fn(async () => ({
    authenticatedAt: new Date(),
    method: "password",
    userId: "subject",
  })),
}));

afterEach(() => vi.restoreAllMocks());

describe("privacy delivery ceremony", () => {
  it.each([false, true])("retains the nonce until download (assisted=%s)", async (assisted) => {
    const app = Fastify();
    const complete = vi
      .spyOn(PrivacyReauthenticationService.prototype, "complete")
      .mockResolvedValue();
    const chain: Record<string, unknown> = {
      // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are intentionally awaitable.
      then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
    };
    for (const name of ["from", "where", "for", "limit"]) chain[name] = () => chain;
    const fixtureDatabase = {
      select: () => chain,
      insert: () => ({ values: async () => undefined }),
      transaction: async (run: (tx: unknown) => Promise<unknown>) => run(fixtureDatabase),
    };
    const database = fixtureDatabase as never;
    if (assisted) await app.register(privacyAdminRoute, { database });
    else await app.register(privacyRequestsRoute, { database });
    try {
      const challengeId = randomUUID();
      const result = await app.inject({
        method: "POST",
        url: `${assisted ? "/privacy/admin/requests" : "/privacy/data-requests"}/${randomUUID()}/artifacts/${randomUUID()}/reauth/complete`,
        headers: {
          "idempotency-key": randomUUID(),
          cookie: `${REAUTH_COOKIE_NAME}=${challengeId}.${Buffer.alloc(32, 7).toString("base64url")}`,
        },
        payload: { challengeId },
      });
      expect(result.statusCode).toBe(200);
      expect(complete).toHaveBeenCalledOnce();
      expect(result.headers["set-cookie"]).toBeUndefined();
      expect(result.headers["cache-control"]).toContain("no-store");
    } finally {
      await app.close();
    }
  });
});
