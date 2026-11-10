import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MAIL_RECIPIENT_HOURLY_LIMIT } from "../mail-recipient-limit";

const mocks = vi.hoisted(() => {
  const counts = new Map<string, number>();
  return {
    counts,
    smtp: vi.fn(async () => ({})),
    disclosure: vi.fn(async () => undefined),
    store: {
      eval: vi.fn(async (_script: string, _keys: number, key: string) => {
        const next = (counts.get(key) ?? 0) + 1;
        counts.set(key, next);
        return next;
      }),
    },
  };
});
vi.mock("../../db", () => ({ db: { select: () => ({ from: async () => [] }) } }));
vi.mock("../../redis", () => ({ redis: mocks.store }));
vi.mock("../../privacy/disclosures.js", () => ({
  recordDataDisclosureBestEffort: mocks.disclosure,
}));
vi.mock("nodemailer", () => ({ createTransport: () => ({ sendMail: mocks.smtp }) }));

import { sendMail, sendMailOrRefuse } from "../email";
import { MailDeliveryRefusedError } from "../mail-outcome";

beforeEach(() => {
  mocks.counts.clear();
  mocks.smtp.mockClear();
  mocks.disclosure.mockClear();
  vi.stubEnv("EMAILLABS_APP_KEY", "");
  vi.stubEnv("LETTERMINT_API_TOKEN", "");
});
afterEach(() => vi.unstubAllEnvs());

const message = (to: string) => ({
  to,
  subject: "Synthetic",
  text: "synthetic mail",
  disclosure: { userId: "user-1", operationCode: "auth.reset-password.email" },
});

it("stops delivering to one mailbox at the hourly limit without telling the caller", async () => {
  for (let index = 0; index < MAIL_RECIPIENT_HOURLY_LIMIT; index += 1)
    await expect(sendMail(message("person@example.test"))).resolves.toBe("sent");
  await expect(sendMail(message("Person+again@example.test"))).resolves.toBe("limited");
  expect(mocks.smtp).toHaveBeenCalledTimes(MAIL_RECIPIENT_HOURLY_LIMIT);
  expect(mocks.disclosure).toHaveBeenCalledTimes(MAIL_RECIPIENT_HOURLY_LIMIT);
  await expect(sendMail(message("other@example.test"))).resolves.toBe("sent");
  expect(mocks.smtp).toHaveBeenCalledTimes(MAIL_RECIPIENT_HOURLY_LIMIT + 1);
});

it("delivers uncounted when the shared store cannot answer", async () => {
  mocks.store.eval.mockRejectedValueOnce(new Error("connection refused"));
  await expect(sendMail(message("person@example.test"))).resolves.toBe("sent");
  expect(mocks.smtp).toHaveBeenCalledOnce();
});

it("refuses delivery for retrying queues once the allowance is spent", async () => {
  for (let index = 0; index < MAIL_RECIPIENT_HOURLY_LIMIT; index += 1)
    await expect(sendMailOrRefuse(message("queued@example.test"))).resolves.toBeUndefined();
  await expect(sendMailOrRefuse(message("queued@example.test"))).rejects.toBeInstanceOf(
    MailDeliveryRefusedError,
  );
  expect(mocks.smtp).toHaveBeenCalledTimes(MAIL_RECIPIENT_HOURLY_LIMIT);
});
