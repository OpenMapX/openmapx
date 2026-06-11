import { contactDomain } from "@openmapx/core";
import { createTransport } from "nodemailer";
import { db } from "../db";
import { systemSettings } from "../db/schema";

interface MailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

type Provider = "emaillabs" | "lettermint" | "smtp";

interface EmailConfig {
  provider: Provider;
  from: string;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
  };
  emaillabs: { appKey: string; secretKey: string; smtpAccount: string };
  lettermint: { apiToken: string };
}

function pickString(env: string | undefined, db: unknown, fallback = ""): string {
  if (env != null && env.length > 0) return env;
  if (typeof db === "string" && db.length > 0) return db;
  return fallback;
}

/**
 * Load the active email configuration by merging environment variables over
 * `system_settings` rows. Env always wins so deployments that pin secrets
 * via .env keep working unchanged; admin-panel values take effect when env
 * is unset. Re-evaluated on every send so admin edits apply without a
 * server restart.
 */
async function loadEmailConfig(): Promise<EmailConfig> {
  const rows = await db.select().from(systemSettings);
  const dbMap = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  const from = pickString(
    process.env.EMAIL_FROM,
    dbMap.smtpFromAddress,
    `OpenMapX <noreply@${contactDomain()}>`,
  );

  const smtpSecureRaw = process.env.SMTP_SECURE;
  const smtpSecure =
    smtpSecureRaw != null
      ? smtpSecureRaw === "true" || smtpSecureRaw === "1"
      : Boolean(dbMap.smtpTls);

  const config: EmailConfig = {
    provider: "smtp",
    from,
    smtp: {
      host: pickString(process.env.SMTP_HOST, dbMap.smtpHost, "localhost"),
      port: Number(process.env.SMTP_PORT ?? dbMap.smtpPort ?? 587),
      secure: smtpSecure,
      user: pickString(process.env.SMTP_USER, dbMap.smtpUser),
      pass: pickString(process.env.SMTP_PASS, dbMap.smtpPassword),
    },
    emaillabs: {
      appKey: pickString(process.env.EMAILLABS_APP_KEY, dbMap.emailLabsAppKey),
      secretKey: pickString(process.env.EMAILLABS_SECRET_KEY, dbMap.emailLabsSecretKey),
      smtpAccount: pickString(process.env.EMAILLABS_SMTP_ACCOUNT, dbMap.emailLabsSmtpAccount),
    },
    lettermint: {
      apiToken: pickString(process.env.LETTERMINT_API_TOKEN, dbMap.lettermintApiToken),
    },
  };

  // Priority chain: EmailLabs (3 fields) > Lettermint (1 field) > SMTP.
  if (config.emaillabs.appKey && config.emaillabs.secretKey && config.emaillabs.smtpAccount) {
    config.provider = "emaillabs";
  } else if (config.lettermint.apiToken) {
    config.provider = "lettermint";
  } else {
    config.provider = "smtp";
  }

  return config;
}

/** Parse "Name <addr>" or plain "addr" into { name, address }. */
function parseFrom(raw: string): { name: string; address: string } {
  const match = raw.match(/^(.+?)\s*<(.+)>$/);
  if (match) return { name: match[1].trim(), address: match[2].trim() };
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
    headers: {
      Authorization: `Basic ${btoa(`${appKey}:${secretKey}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`EmailLabs API error ${res.status}: ${body}`);
  }
}

async function sendViaLettermint(opts: MailOptions, config: EmailConfig): Promise<void> {
  const { Lettermint } = await import("lettermint");
  const client = new Lettermint({ apiToken: config.lettermint.apiToken });

  let builder = client.email.from(config.from).to(opts.to).subject(opts.subject).text(opts.text);
  if (opts.html) builder = builder.html(opts.html);
  await builder.send();
}

async function sendViaSmtp(opts: MailOptions, config: EmailConfig): Promise<void> {
  const transporter = createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });

  await transporter.sendMail({ from: config.from, ...opts });
}

export async function sendMail(opts: MailOptions): Promise<void> {
  const config = await loadEmailConfig();
  switch (config.provider) {
    case "emaillabs":
      return sendViaEmailLabs(opts, config);
    case "lettermint":
      return sendViaLettermint(opts, config);
    case "smtp":
      return sendViaSmtp(opts, config);
    default: {
      const _exhaustive: never = config.provider;
      throw new Error(`Unknown email provider: ${String(_exhaustive)}`);
    }
  }
}

export type { EmailConfig };
// Exported for the admin test-email route so it can dispatch to whichever
// provider is currently active without duplicating the resolution logic.
export { loadEmailConfig, sendViaEmailLabs, sendViaLettermint, sendViaSmtp };
