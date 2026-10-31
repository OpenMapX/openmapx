import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { privacyAdminRoute } from "../routes/privacy-admin.js";

vi.mock("../auth.js", () => ({
  auth: {
    api: {
      getSession: async () => ({
        user: { id: "worker", role: "privacy_admin" },
        session: { id: "session" },
      }),
    },
  },
}));
describe("privacy case transport boundaries", () => {
  it.each([
    [
      "extension",
      {
        version: "1",
        extendedUntil: "2030-03-01T00:00:00Z",
        extensionNotifiedAt: "2030-01-01T00:00:00Z",
        reasonCode: "complexity",
      },
    ],
    ["decision", { version: 1, decision: "refused", reasonCode: "scope", injected: "untrusted" }],
  ])("rejects noncanonical %s before service mutation", async (action, body) => {
    const recordExtension = vi.fn(async () => ({}));
    const recordDecision = vi.fn(async () => ({}));
    const app = Fastify();
    await app.register(privacyAdminRoute, {
      database: {} as never,
      service: { recordExtension, recordDecision } as never,
    });
    try {
      const r = await app.inject({
        method: "POST",
        url: `/privacy/admin/requests/${randomUUID()}/${action}`,
        headers: { "idempotency-key": randomUUID() },
        payload: body,
      });
      expect(r.statusCode).toBe(400);
      expect(recordExtension).not.toHaveBeenCalled();
      expect(recordDecision).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
