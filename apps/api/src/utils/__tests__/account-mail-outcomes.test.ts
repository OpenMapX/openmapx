import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MailDeliveryRefusedError } from "../mail-outcome";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), smtp: vi.fn() }));
vi.mock("../../db", () => ({ db: { select: () => ({ from: async () => [] }) } }));
vi.mock("nodemailer", () => ({ createTransport: () => ({ sendMail: mocks.smtp }) }));

import { sendMail } from "../email";

beforeEach(() => {
  vi.stubGlobal("fetch", mocks.fetch);
  vi.stubEnv("EMAILLABS_APP_KEY", "synthetic");
  vi.stubEnv("EMAILLABS_SECRET_KEY", "synthetic");
  vi.stubEnv("EMAILLABS_SMTP_ACCOUNT", "synthetic");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const message = { to: "synthetic@example.test", subject: "Synthetic", text: "synthetic mail" };
it("distinguishes a conclusive HTTP refusal from an ambiguous server failure", async () => {
  mocks.fetch.mockResolvedValue(
    new Response("synthetic private provider diagnostic", { status: 400 }),
  );
  await expect(sendMail(message)).rejects.toBeInstanceOf(MailDeliveryRefusedError);
  mocks.fetch.mockResolvedValue(
    new Response("synthetic private provider diagnostic", { status: 500 }),
  );
  await expect(sendMail(message)).rejects.not.toBeInstanceOf(MailDeliveryRefusedError);
});
it("recognizes only an actual SMTP rejection, leaving connection loss ambiguous", async () => {
  vi.stubEnv("EMAILLABS_APP_KEY", "");
  mocks.smtp.mockRejectedValue(
    Object.assign(Error("synthetic rejection"), { command: "DATA", responseCode: 550 }),
  );
  await expect(sendMail(message)).rejects.toBeInstanceOf(MailDeliveryRefusedError);
  mocks.smtp.mockRejectedValue(
    Object.assign(Error("synthetic connection loss"), { code: "ESOCKET", command: "DATA" }),
  );
  await expect(sendMail(message)).rejects.not.toBeInstanceOf(MailDeliveryRefusedError);
});
