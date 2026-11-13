import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
suite("privacy notifications and the per-recipient auth mail limit", () => {
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
        encryptedLocator: "synthetic",
        receivedAt: new Date(),
        dueAt: new Date(Date.now() + 30 * 86_400_000),
        state: "in_progress",
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
      .select({ state: dataSubjectRequestNotification.state })
      .from(dataSubjectRequestNotification)
      .where(eq(dataSubjectRequestNotification.requestId, request.id));
    expect(row?.state).toBe("sent");
  });
});
