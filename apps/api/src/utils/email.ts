import { createTransport } from "nodemailer";

interface MailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

const from = process.env.EMAIL_FROM ?? "OpenMapX <noreply@openmapx.org>";

/** Parse "Name <addr>" or plain "addr" into { name, address }. */
function parseFrom(raw: string): { name: string; address: string } {
  const match = raw.match(/^(.+?)\s*<(.+)>$/);
  if (match) return { name: match[1].trim(), address: match[2].trim() };
  return { name: "", address: raw.trim() };
}

async function sendViaEmailLabs(opts: MailOptions): Promise<void> {
  const appKey = process.env.EMAILLABS_APP_KEY as string;
  const secretKey = process.env.EMAILLABS_SECRET_KEY as string;
  const smtpAccount = process.env.EMAILLABS_SMTP_ACCOUNT as string;
  const { name, address } = parseFrom(from);

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

async function sendViaLettermint(opts: MailOptions): Promise<void> {
  const { Lettermint } = await import("lettermint");
  const client = new Lettermint({ apiToken: process.env.LETTERMINT_API_TOKEN as string });

  let builder = client.email.from(from).to(opts.to).subject(opts.subject).text(opts.text);
  if (opts.html) builder = builder.html(opts.html);
  await builder.send();
}

async function sendViaSmtp(opts: MailOptions): Promise<void> {
  const transporter = createTransport({
    host: process.env.SMTP_HOST ?? "localhost",
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER ?? "",
      pass: process.env.SMTP_PASS ?? "",
    },
  });

  await transporter.sendMail({ from, ...opts });
}

type Provider = "emaillabs" | "lettermint" | "smtp";

function resolveProvider(): Provider {
  if (
    process.env.EMAILLABS_APP_KEY &&
    process.env.EMAILLABS_SECRET_KEY &&
    process.env.EMAILLABS_SMTP_ACCOUNT
  ) {
    return "emaillabs";
  }
  if (process.env.LETTERMINT_API_TOKEN) {
    return "lettermint";
  }
  return "smtp";
}

const provider = resolveProvider();

export async function sendMail(opts: MailOptions): Promise<void> {
  switch (provider) {
    case "emaillabs":
      return sendViaEmailLabs(opts);
    case "lettermint":
      return sendViaLettermint(opts);
    case "smtp":
      return sendViaSmtp(opts);
  }
}
