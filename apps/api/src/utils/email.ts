import { createTransport } from "nodemailer";

const transporter = createTransport({
  host: process.env.SMTP_HOST ?? "localhost",
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER ?? "",
    pass: process.env.SMTP_PASS ?? "",
  },
});

const from = process.env.SMTP_FROM ?? "OpenMapX <noreply@openmapx.org>";

export async function sendMail(opts: { to: string; subject: string; text: string; html?: string }) {
  await transporter.sendMail({ from, ...opts });
}
