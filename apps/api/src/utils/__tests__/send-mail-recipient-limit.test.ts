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

import { sendAuthMail, sendMail } from "../email";

beforeEach(() => {
  mocks.counts.clear();
  mocks.smtp.mockClear();
  mocks.disclosure.mockClear();
  mocks.store.eval.mockClear();
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

it("stops request-driven auth mail to one mailbox at the hourly limit, silently", async () => {
  for (let index = 0; index < MAIL_RECIPIENT_HOURLY_LIMIT; index += 1)
    await expect(sendAuthMail(message("person@example.test"))).resolves.toBeUndefined();
  await expect(sendAuthMail(message("Person+again@example.test"))).resolves.toBeUndefined();
  expect(mocks.smtp).toHaveBeenCalledTimes(MAIL_RECIPIENT_HOURLY_LIMIT);
  expect(mocks.disclosure).toHaveBeenCalledTimes(MAIL_RECIPIENT_HOURLY_LIMIT);
  await sendAuthMail(message("other@example.test"));
  expect(mocks.smtp).toHaveBeenCalledTimes(MAIL_RECIPIENT_HOURLY_LIMIT + 1);
});

it("neither counts nor limits privacy and administrator mail", async () => {
  for (let index = 0; index <= MAIL_RECIPIENT_HOURLY_LIMIT; index += 1)
    await sendAuthMail(message("person@example.test"));
  expect(mocks.smtp).toHaveBeenCalledTimes(MAIL_RECIPIENT_HOURLY_LIMIT);
  const countedCalls = mocks.store.eval.mock.calls.length;

  await sendMail(message("person@example.test"));
  expect(mocks.smtp).toHaveBeenCalledTimes(MAIL_RECIPIENT_HOURLY_LIMIT + 1);
  expect(mocks.store.eval.mock.calls).toHaveLength(countedCalls);
});

it("delivers auth mail uncounted when the shared store cannot answer", async () => {
  mocks.store.eval.mockRejectedValueOnce(new Error("connection refused"));
  await sendAuthMail(message("person@example.test"));
  expect(mocks.smtp).toHaveBeenCalledOnce();
});
