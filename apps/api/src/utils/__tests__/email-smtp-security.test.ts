import { afterEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  createTransport: vi.fn(() => ({ sendMail: vi.fn().mockResolvedValue({}) })),
}));
vi.mock("nodemailer", () => ({ createTransport: transport.createTransport }));
vi.mock("../../db", () => ({ db: {} }));
vi.mock("../../redis", () => ({ redis: {} }));

const { sendViaSmtp, smtpTransportSecurity } = await import("../email");
const { resolveSetting } = await import("../../services/settings");

const config: Parameters<typeof sendViaSmtp>[1] = {
  provider: "smtp",
  from: "OpenMapX <noreply@example.com>",
  smtp: { host: "mail.example.test", port: 587, security: "starttls", user: "u", pass: "p" },
  emaillabs: { appKey: "", secretKey: "", smtpAccount: "" },
  lettermint: { apiToken: "" },
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("SMTP connection security", () => {
  it("maps each mode to the nodemailer options it names", () => {
    expect(smtpTransportSecurity("starttls")).toEqual({
      secure: false,
      requireTLS: true,
      ignoreTLS: false,
    });
    expect(smtpTransportSecurity("tls")).toEqual({
      secure: true,
      requireTLS: false,
      ignoreTLS: false,
    });
    expect(smtpTransportSecurity("none")).toEqual({
      secure: false,
      requireTLS: false,
      ignoreTLS: true,
    });
  });

  it("refuses to send unencrypted by default", async () => {
    await sendViaSmtp({ to: "person@example.test", subject: "s", text: "t" }, config);
    expect(transport.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ secure: false, requireTLS: true, ignoreTLS: false }),
    );
  });

  it("treats an empty SMTP_SECURITY as unset, as Compose passes it", async () => {
    vi.stubEnv("SMTP_SECURITY", "");
    expect(await resolveSetting("smtp.security", { database: null })).toBe("starttls");
  });

  it("reads tls and none from the environment", async () => {
    vi.stubEnv("SMTP_SECURITY", "tls");
    expect(await resolveSetting("smtp.security", { database: null })).toBe("tls");
    vi.stubEnv("SMTP_SECURITY", "none");
    expect(await resolveSetting("smtp.security", { database: null })).toBe("none");
  });

  it("refuses a value that is not a mode, naming the variable", async () => {
    vi.stubEnv("SMTP_SECURITY", "true");
    await expect(resolveSetting("smtp.security", { database: null })).rejects.toThrow(
      /SMTP_SECURITY is invalid/,
    );
  });
});
