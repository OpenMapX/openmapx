import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { dataSubjectRequest, dataSubjectRequestNotification, user } from "../db/schema";
import { createMigratedPostgresFixture } from "../test/postgres-fixture";
import { MAIL_RECIPIENT_HOURLY_LIMIT } from "../utils/mail-recipient-limit";

const mocks = vi.hoisted(() => {
  const counts = new Map<string, number>();
  return {
    smtp: vi.fn(async (_message: { to: string }) => ({})),
    store: {
      eval: vi.fn(async (_script: string, _keys: number, key: string) => {
        const next = (counts.get(key) ?? 0) + 1;
        counts.set(key, next);
        return next;
      }),
    },
  };
});

const suite = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
suite("privacy notification dispatcher against PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createMigratedPostgresFixture>>;

  beforeAll(async () => {
    fixture = await createMigratedPostgresFixture();
    vi.doMock("../db", () => ({ db: fixture.db, sql: fixture.sql }));
    vi.doMock("../db/index.js", () => ({ db: fixture.db, sql: fixture.sql }));
    vi.doMock("../redis", () => ({ redis: mocks.store }));
    vi.doMock("nodemailer", () => ({ createTransport: () => ({ sendMail: mocks.smtp }) }));
    vi.stubEnv("EMAILLABS_APP_KEY", "");
    vi.stubEnv("LETTERMINT_API_TOKEN", "");
  }, 120_000);

  afterAll(async () => {
    try {
      await fixture?.stop();
    } finally {
      vi.doUnmock("../db");
      vi.doUnmock("../db/index.js");
      vi.doUnmock("../redis");
      vi.doUnmock("nodemailer");
      vi.unstubAllEnvs();
    }
  });

  it("still sends a privacy notification after the recipient's auth allowance is spent", async () => {
    const { sendAuthMail } = await import("../utils/email");
    const { dispatchPrivacyNotifications, enqueuePrivacyNotification } = await import(
      "./notifications"
    );
    const email = "subject@example.test";
    const [subject] = await fixture.db
      .insert(user)
      .values({ id: randomUUID(), name: "Data subject", email })
      .returning();
    const [request] = await fixture.db
      .insert(dataSubjectRequest)
      .values({
        kind: "access",
        channel: "email",
        locatorType: "other_reference",
        receivedAt: new Date(),
        dueAt: new Date(Date.now() + 30 * 86_400_000),
        status: "in_progress",
        identityMethod: "manual",
        identityVerifiedAt: new Date(),
      })
      .returning();
    if (!subject || !request) throw new Error("Fixture rows were not created");

    for (let index = 0; index <= MAIL_RECIPIENT_HOURLY_LIMIT; index += 1)
      await sendAuthMail({ to: email, subject: "Reset", text: "synthetic reset code" });
    expect(mocks.smtp).toHaveBeenCalledTimes(MAIL_RECIPIENT_HOURLY_LIMIT);

    await enqueuePrivacyNotification(
      {
        requestId: request.id,
        recipientUserId: subject.id,
        template: "acknowledgement",
        channel: "email",
        locale: "en",
        payload: {},
      },
      fixture.db,
    );
    await expect(dispatchPrivacyNotifications({ database: fixture.db })).resolves.toMatchObject({
      sent: 1,
      retried: 0,
    });
    expect(mocks.smtp).toHaveBeenCalledTimes(MAIL_RECIPIENT_HOURLY_LIMIT + 1);
    expect(mocks.smtp.mock.calls.at(-1)?.[0]).toMatchObject({ to: email });
    const [row] = await fixture.db
      .select({ status: dataSubjectRequestNotification.status })
      .from(dataSubjectRequestNotification)
      .where(eq(dataSubjectRequestNotification.requestId, request.id));
    expect(row?.status).toBe("sent");
  });

  describe("stale sending claims", () => {
    const MIN = 60_000;
    const requestIds: string[] = [];

    afterEach(async () => {
      for (const requestId of requestIds.splice(0))
        await fixture.db
          .delete(dataSubjectRequestNotification)
          .where(eq(dataSubjectRequestNotification.requestId, requestId));
    });

    async function insertClaim(attempts: number, claimedAt: Date) {
      const email = `stale-${randomUUID()}@example.test`;
      const [subject] = await fixture.db
        .insert(user)
        .values({ id: randomUUID(), name: "Data subject", email })
        .returning();
      const [request] = await fixture.db
        .insert(dataSubjectRequest)
        .values({
          kind: "access",
          channel: "email",
          locatorType: "other_reference",
          receivedAt: new Date(),
          dueAt: new Date(Date.now() + 30 * 86_400_000),
          status: "in_progress",
          identityMethod: "manual",
          identityVerifiedAt: new Date(),
        })
        .returning();
      if (!subject || !request) throw new Error("Fixture rows were not created");
      requestIds.push(request.id);
      const [row] = await fixture.db
        .insert(dataSubjectRequestNotification)
        .values({
          requestId: request.id,
          recipientUserId: subject.id,
          template: "acknowledgement",
          channel: "email",
          locale: "en",
          payload: {},
          status: "sending",
          attempts,
          nextAttemptAt: null,
          createdAt: new Date(),
          updatedAt: claimedAt,
        })
        .returning();
      if (!row) throw new Error("Notification row was not created");
      return { request, subject, email, row };
    }

    async function readRow(id: string) {
      const [row] = await fixture.db
        .select()
        .from(dataSubjectRequestNotification)
        .where(eq(dataSubjectRequestNotification.id, id));
      return row;
    }

    it("resends a claim abandoned longer than the stale threshold", async () => {
      const { dispatchPrivacyNotifications } = await import("./notifications");
      const { email, row } = await insertClaim(1, new Date(Date.now() - 16 * MIN));
      const send = vi.fn(async () => undefined);

      const result = await dispatchPrivacyNotifications({
        database: fixture.db,
        send: send as never,
      });

      expect(result).toMatchObject({ sent: 1 });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: email }));
      const stored = await readRow(row.id);
      expect(stored).toMatchObject({ status: "sent", attempts: 2 });
      expect(stored?.sentAt).not.toBeNull();
    });

    it("leaves a recent claim to its live dispatcher", async () => {
      const { dispatchPrivacyNotifications } = await import("./notifications");
      const claimedAt = new Date(Date.now() - 1 * MIN);
      const { row } = await insertClaim(1, claimedAt);
      const send = vi.fn(async () => undefined);

      await dispatchPrivacyNotifications({ database: fixture.db, send: send as never });

      expect(send).not.toHaveBeenCalled();
      const stored = await readRow(row.id);
      expect(stored).toMatchObject({ status: "sending", attempts: 1 });
      expect(stored?.updatedAt.getTime()).toBe(claimedAt.getTime());
    });

    it("fails an abandoned claim that already used its last attempt", async () => {
      const { dispatchPrivacyNotifications } = await import("./notifications");
      const { row } = await insertClaim(5, new Date(Date.now() - 16 * MIN));
      const send = vi.fn(async () => undefined);

      const result = await dispatchPrivacyNotifications({
        database: fixture.db,
        send: send as never,
      });

      expect(result).toMatchObject({ failed: 1, sent: 0 });
      expect(send).not.toHaveBeenCalled();
      expect(await readRow(row.id)).toMatchObject({
        status: "failed",
        lastErrorCode: "DELIVERY_INTERRUPTED",
        nextAttemptAt: null,
        attempts: 5,
      });
    });

    it("honours a custom maxAttempts and threshold", async () => {
      const { dispatchPrivacyNotifications } = await import("./notifications");
      const { row } = await insertClaim(2, new Date(Date.now() - 3 * MIN));
      const send = vi.fn(async () => undefined);

      await dispatchPrivacyNotifications({
        database: fixture.db,
        send: send as never,
        maxAttempts: 2,
        staleSendingMs: 2 * MIN,
      });

      expect(send).not.toHaveBeenCalled();
      expect(await readRow(row.id)).toMatchObject({ status: "failed" });
    });

    it("sends a recovered claim once when two dispatchers race", async () => {
      const { dispatchPrivacyNotifications } = await import("./notifications");
      const { row } = await insertClaim(1, new Date(Date.now() - 16 * MIN));
      const send = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      await Promise.all([
        dispatchPrivacyNotifications({ database: fixture.db, send: send as never }),
        dispatchPrivacyNotifications({ database: fixture.db, send: send as never }),
      ]);

      expect(send).toHaveBeenCalledTimes(1);
      expect(await readRow(row.id)).toMatchObject({ status: "sent", attempts: 2 });
    });

    it("retries a recovered claim that fails again", async () => {
      const { dispatchPrivacyNotifications } = await import("./notifications");
      const { row } = await insertClaim(1, new Date(Date.now() - 16 * MIN));
      const send = vi.fn(async () => {
        throw new Error("boom");
      });

      await dispatchPrivacyNotifications({ database: fixture.db, send: send as never });

      const stored = await readRow(row.id);
      expect(stored).toMatchObject({ status: "retryable", attempts: 2, lastErrorCode: "ERROR" });
      expect(stored?.nextAttemptAt?.getTime()).toBeGreaterThan(Date.now());
    });
  });
});
