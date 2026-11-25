import { contactDomain } from "@openmapx/core";
import type { EmailDisclosure, TransferSafeguard } from "@openmapx/integration-framework";
import { createTransport } from "nodemailer";
import { recordDataDisclosureBestEffort } from "../privacy/disclosures.js";
import { redis } from "../redis";
import { appLogger } from "../services/app-logger.js";
import {
  resolveSetting,
  resolveSettingValues,
  type SmtpSecurity,
  settingDefinition,
  settingFromEnvironment,
  storedSecretSettingKeys,
} from "../services/settings.js";
import { MailDeliveryRefusedError } from "./mail-outcome";
import { createMailRecipientLimit } from "./mail-recipient-limit";

const recipientLimit = createMailRecipientLimit({
  store: redis,
  onUnavailable: () =>
    appLogger.add({
      level: "warn",
      source: "mail",
      message: "Mail recipient limit unavailable; message sent uncounted",
      time: Date.now(),
    }),
});

export interface MailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Optional account-linked disclosure context. The address/body never enter
   * the ledger; only the controlled operation/category codes do. */
  disclosure?: {
    userId: string;
    operationCode: string;
    categoryCode?: string;
    purposeCode?: string;
    legalBasisCode?: string;
    idempotencyKey?: string;
  };
}

type Provider = "emaillabs" | "lettermint" | "smtp";

interface EmailConfig {
  provider: Provider;
  from: string;
  smtp: {
    host: string;
    port: number;
    security: SmtpSecurity;
    user: string;
    pass: string;
  };
  emaillabs: { appKey: string; secretKey: string; smtpAccount: string };
  lettermint: { apiToken: string };
}

/** The secret settings each provider needs; only the active provider's are decrypted. */
const PROVIDER_SECRETS: Record<Provider, readonly string[]> = {
  emaillabs: ["emaillabs.appKey", "emaillabs.secretKey"],
  lettermint: ["lettermint.apiToken"],
  smtp: ["smtp.password"],
};

/** The nodemailer connection options for a security mode. */
export function smtpTransportSecurity(security: SmtpSecurity): {
  secure: boolean;
  requireTLS: boolean;
  ignoreTLS: boolean;
} {
  switch (security) {
    case "tls":
      return { secure: true, requireTLS: false, ignoreTLS: false };
    case "starttls":
      return { secure: false, requireTLS: true, ignoreTLS: false };
    case "none":
      return { secure: false, requireTLS: false, ignoreTLS: true };
  }
}

/**
 * The active provider, by priority EmailLabs (3 fields) > Lettermint (1 field)
 * > SMTP. A secret counts as configured when its environment variable is set
 * or a value is stored; nothing is decrypted to decide.
 */
async function activeProvider(): Promise<Provider> {
  const storedSecrets = await storedSecretSettingKeys();
  const configured = (key: string) =>
    storedSecrets.has(key) || settingFromEnvironment(settingDefinition(key)) !== undefined;
  const smtpAccount = (await resolveSetting("emaillabs.smtpAccount")) as string;
  if (configured("emaillabs.appKey") && configured("emaillabs.secretKey") && smtpAccount)
    return "emaillabs";
  if (configured("lettermint.apiToken")) return "lettermint";
  return "smtp";
}

/**
 * Load the active email configuration through the settings resolver: an
 * environment variable wins, then the administration's stored value, then the
 * default. Only the active provider's secrets are decrypted, so an unreadable
 * stored value of another provider never breaks sending. Throws
 * SecretSettingUnreadableError when a needed value cannot be decrypted.
 * Re-evaluated on every send so admin edits apply without a server restart.
 */
async function loadEmailConfig(): Promise<EmailConfig> {
  const provider = await activeProvider();
  const values = await resolveSettingValues([
    "email.fromAddress",
    "emaillabs.smtpAccount",
    "smtp.host",
    "smtp.port",
    "smtp.user",
    "smtp.security",
    ...PROVIDER_SECRETS[provider],
  ]);
  const text = (key: string) => (values[key] as string | undefined) ?? "";
  return {
    provider,
    from: text("email.fromAddress") || `OpenMapX <noreply@${contactDomain()}>`,
    smtp: {
      host: text("smtp.host") || "localhost",
      port: values["smtp.port"] as number,
      security: values["smtp.security"] as SmtpSecurity,
      user: text("smtp.user"),
      pass: text("smtp.password"),
    },
    emaillabs: {
      appKey: text("emaillabs.appKey"),
      secretKey: text("emaillabs.secretKey"),
      smtpAccount: text("emaillabs.smtpAccount"),
    },
    lettermint: { apiToken: text("lettermint.apiToken") },
  };
}

/** Parse "Name <addr>" or plain "addr" into { name, address }. */
function parseFrom(raw: string): { name: string; address: string } {
  const [, name, address] = raw.match(/^(.+?)\s*<(.+)>$/) ?? [];
  if (name !== undefined && address !== undefined)
    return { name: name.trim(), address: address.trim() };
  return { name: "", address: raw.trim() };
}

async function sendViaEmailLabs(opts: MailOptions, config: EmailConfig): Promise<void> {
  const { appKey, secretKey, smtpAccount } = config.emaillabs;
  const { name, address } = parseFrom(config.from);

  const params = new URLSearchParams();
  params.append(`to[${opts.to}]`, "");
  params.append("smtp_account", smtpAccount);
  params.append("subject", opts.subject);
  params.append("from", address);
  if (name) params.append("from_name", name);
  if (opts.html) params.append("html", opts.html);
  params.append("text", opts.text);

  const res = await fetch("https://api.emaillabs.net.pl/api/new_sendmail", {
    method: "POST",
    signal: AbortSignal.timeout(30000),
    headers: {
      Authorization: `Basic ${btoa(`${appKey}:${secretKey}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!res.ok) {
    if (res.status >= 400 && res.status < 500) throw new MailDeliveryRefusedError();
    throw new Error("Mail delivery outcome is unknown");
  }
}

async function sendViaLettermint(opts: MailOptions, config: EmailConfig): Promise<void> {
  const { Lettermint } = await import("lettermint");
  const client = new Lettermint({ sendingToken: config.lettermint.apiToken });

  await client.emails.send({
    from: config.from,
    to: [opts.to],
    subject: opts.subject,
    text: opts.text,
    ...(opts.html ? { html: opts.html } : {}),
  });
}

async function sendViaSmtp(opts: MailOptions, config: EmailConfig): Promise<void> {
  const transporter = createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    ...smtpTransportSecurity(config.smtp.security),
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 30000,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });

  try {
    await transporter.sendMail({ from: config.from, ...opts });
  } catch (error) {
    const detail = error as { command?: unknown; responseCode?: unknown };
    if (
      typeof detail.responseCode === "number" &&
      detail.responseCode >= 400 &&
      detail.responseCode < 600 &&
      typeof detail.command === "string" &&
      /^(DATA|MAIL FROM|RCPT TO|AUTH(?: .*)?)$/.test(detail.command)
    )
      throw new MailDeliveryRefusedError();
    throw error;
  }
}

export async function sendMail(opts: MailOptions): Promise<void> {
  const config = await loadEmailConfig();
  const { disclosure, ...message } = opts;
  switch (config.provider) {
    case "emaillabs":
      await sendViaEmailLabs(message, config);
      break;
    case "lettermint":
      await sendViaLettermint(message, config);
      break;
    case "smtp":
      await sendViaSmtp(message, config);
      break;
    default: {
      const _exhaustive: never = config.provider;
      throw new Error(`Unknown email provider: ${String(_exhaustive)}`);
    }
  }
  if (disclosure) {
    // Mail delivery is irreversible. A missing ledger write is surfaced only
    // to the reconciliation metric; it must not make the caller resend mail.
    await recordDataDisclosureBestEffort({
      userId: disclosure.userId,
      occurredAt: new Date(),
      recipientId: "email-processor",
      operationCode: disclosure.operationCode,
      categoryCode: disclosure.categoryCode ?? "email-delivery",
      purposeCode: disclosure.purposeCode ?? "communications",
      legalBasisCode: disclosure.legalBasisCode ?? "contract",
      ...(disclosure.idempotencyKey ? { idempotencyKey: disclosure.idempotencyKey } : {}),
    });
  }
}

/**
 * Sends authentication mail that an anonymous request can trigger: sign-up
 * verification, verification resend, password reset and email-code mail.
 * Beyond the recipient's hourly allowance the message is dropped silently, so
 * the response never reveals the limit or whether the address has an account.
 * Administrator-initiated and privacy mail use `sendMail` and are not counted.
 */
export async function sendAuthMail(opts: MailOptions): Promise<void> {
  if (!(await recipientLimit.admit(opts.to))) return;
  await sendMail(opts);
}

const TRANSFER_SAFEGUARDS = ["eea", "adequacy", "dpf", "scc", "none"] as const;

/**
 * Static processor metadata for the named (non-SMTP) email providers, kept here
 * next to the provider definitions so a new provider can't be added without its
 * Art. 28 disclosure — the Record is exhaustive over Provider.
 */
const PROVIDER_DISCLOSURE: Record<
  Exclude<Provider, "smtp">,
  Omit<EmailDisclosure, "type" | "provider">
> = {
  emaillabs: {
    vendorName: "EmailLabs (Vercom S.A.)",
    countryCode: "PL",
    privacyUrl: "https://emaillabs.io/en/privacy-policy/",
    transfer: "eea",
  },
  lettermint: {
    vendorName: "Lettermint",
    countryCode: "NL",
    privacyUrl: "https://lettermint.co/privacy-policy",
    transfer: "eea",
  },
};

function envTransfer(): TransferSafeguard {
  const raw = process.env.LEGAL_EMAIL_PROVIDER_TRANSFER?.trim().toLowerCase() ?? "";
  return (TRANSFER_SAFEGUARDS as readonly string[]).includes(raw)
    ? (raw as TransferSafeguard)
    : "none";
}

/** Build the legal email-processor disclosure for the active provider. */
export function buildEmailDisclosure(provider: Provider): EmailDisclosure {
  if (provider !== "smtp") {
    return { type: "email", provider, ...PROVIDER_DISCLOSURE[provider] };
  }
  // Self-hosted SMTP: operator-described via env (LEGAL_EMAIL_PROVIDER_*).
  return {
    type: "email",
    provider: "smtp",
    vendorName: process.env.LEGAL_EMAIL_PROVIDER_NAME?.trim() ?? "",
    countryCode: (process.env.LEGAL_EMAIL_PROVIDER_COUNTRY?.trim() ?? "").toUpperCase(),
    privacyUrl: process.env.LEGAL_EMAIL_PROVIDER_PRIVACY_URL?.trim() || undefined,
    transfer: envTransfer(),
  };
}

let disclosureCache: { value: EmailDisclosure; at: number } | null = null;
const DISCLOSURE_TTL_MS = 60_000;

/**
 * The active email provider as a legal disclosure for the Privacy Policy, cached
 * briefly so the shared /api/integrations endpoint doesn't read system_setting
 * on every request. Admin changes apply within the TTL.
 */
export async function getEmailDisclosure(): Promise<EmailDisclosure> {
  const now = Date.now();
  if (disclosureCache && now - disclosureCache.at < DISCLOSURE_TTL_MS) {
    return disclosureCache.value;
  }
  // Which provider is configured is all the disclosure needs; nothing is decrypted.
  const provider = await activeProvider();
  const value = buildEmailDisclosure(provider);
  disclosureCache = { value, at: now };
  return value;
}

export type { EmailConfig };
// Exported for the admin test-email route so it can dispatch to whichever
// provider is currently active without duplicating the resolution logic.
export { loadEmailConfig, sendViaEmailLabs, sendViaLettermint, sendViaSmtp };
