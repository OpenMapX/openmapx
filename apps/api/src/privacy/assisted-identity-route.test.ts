import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { privacyAdminRoute } from "../routes/privacy-admin.js";

vi.mock("../auth.js", () => ({
  auth: {
    api: {
      getSession: async () => ({
        user: { id: "caseworker", role: "privacy_admin" },
        session: { id: "caseworker-session" },
      }),
    },
  },
}));

describe("assisted identity challenge routes", () => {
  it("issues only to the service-derived recipient and accepts a body code", async () => {
    const issue = vi.fn(async () => ({
      challengeId: randomUUID(),
      expiresAt: new Date("2030-01-01T00:10:00.000Z"),
    }));
    const dispatchPending = vi.fn(async () => ({ sent: 1, retried: 0, failed: 0 }));
    const consume = vi.fn(async () => ({ proofId: randomUUID() }));
    const app = Fastify();
    await app.register(privacyAdminRoute, {
      database: {} as never,
      emailChallenge: { issue, dispatchPending, consume } as never,
      sendIdentityChallenge: vi.fn(async () => {}),
    });
    const requestId = randomUUID();
    try {
      const issued = await app.inject({
        method: "POST",
        url: `/privacy/admin/requests/${requestId}/identity/email-challenges`,
        headers: { "idempotency-key": randomUUID() },
        payload: { party: "subject" },
      });
      expect(issued.statusCode).toBe(202);
      expect(issue).toHaveBeenCalledWith({ requestId, party: "subject" });
      expect(dispatchPending).toHaveBeenCalledOnce();

      const challengeId = issued.json().challengeId as string;
      const completed = await app.inject({
        method: "POST",
        url: `/privacy/admin/requests/${requestId}/identity/email-challenges/${challengeId}/complete`,
        headers: { "idempotency-key": randomUUID() },
        payload: { party: "subject", code: "123456" },
      });
      expect(completed.statusCode).toBe(200);
      expect(consume).toHaveBeenCalledWith({
        requestId,
        challengeId,
        party: "subject",
        code: "123456",
      });
    } finally {
      await app.close();
    }
  });

  it("rejects a caller-supplied recipient", async () => {
    const issue = vi.fn();
    const app = Fastify();
    await app.register(privacyAdminRoute, {
      database: {} as never,
      emailChallenge: { issue } as never,
      sendIdentityChallenge: vi.fn(async () => {}),
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/privacy/admin/requests/${randomUUID()}/identity/email-challenges`,
        headers: { "idempotency-key": randomUUID() },
        payload: { party: "subject", recipient: "unrelated@example.test" },
      });
      expect(response.statusCode).toBe(400);
      expect(issue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
