import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { resolveBetterAuthSecret } from "../auth-secret";
import { accountActionReceipt, accountMailOutbox as outbox, user } from "../db/schema";
import { type MailOptions, sendMail } from "../utils/email";
import { MailDeliveryRefusedError } from "../utils/mail-outcome";
import { type AuthDatabase, currentAuthDatabase } from "./auth-database";
export type AccountMailKind = "verification" | "password_setup";
interface SealedMail {
  ciphertext: string;
  iv: string;
  tag: string;
}
const key = (purpose = "encrypted-mail-outbox") =>
  Buffer.from(
    hkdfSync("sha256", resolveBetterAuthSecret(), "openmapx-account-mail-v1", purpose, 32),
  );
export const accountActionDigest = (value: unknown) =>
  createHmac("sha256", key("account-action-receipts")).update(JSON.stringify(value)).digest("hex");
const aad = (actionId: string, kind: AccountMailKind) =>
  Buffer.from(JSON.stringify(["openmapx-account-mail-v1", actionId, kind]));
export function sealAccountMail(
  actionId: string,
  kind: AccountMailKind,
  mail: MailOptions,
): SealedMail {
  const bytes = Buffer.from(JSON.stringify(mail));
  if (bytes.length > 65536) throw Error("Account mail exceeds supported size");
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(aad(actionId, kind));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}
export function openAccountMail(
  actionId: string,
  kind: AccountMailKind,
  sealed: SealedMail,
): MailOptions {
  const cipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(sealed.iv, "base64"));
  cipher.setAAD(aad(actionId, kind));
  cipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  const bytes = Buffer.concat([
    cipher.update(Buffer.from(sealed.ciphertext, "base64")),
    cipher.final(),
  ]);
  return JSON.parse(bytes.toString("utf8")) as MailOptions;
}

async function recordMailOutcome(
  id: string,
  outcome: "sent" | "failed" | "unknown",
  state: "queued" | "sending",
  tx: AuthDatabase,
) {
  const [row] = await tx
    .update(outbox)
    .set({ state: outcome, finishedAt: new Date(), ciphertext: null, iv: null, tag: null })
    .where(and(eq(outbox.id, id), eq(outbox.state, state)))
    .returning({ requestKey: outbox.requestKey, kind: outbox.kind });
  if (!row) return;
  const field = row.kind === "verification" ? "{verificationDelivery}" : "{passwordSetupDelivery}";
  await tx
    .update(accountActionReceipt)
    .set({
      result: sql`jsonb_set(${accountActionReceipt.result},${field}::text[],to_jsonb(${outcome}::text),true)`,
    })
    .where(eq(accountActionReceipt.key, row.requestKey));
}
/** Cancels only unattempted setup messages when a new explicit invitation replaces their token. */
export async function supersedeQueuedPasswordSetup(userId: string, tx: AuthDatabase) {
  const pending = await tx
    .select({ id: outbox.id })
    .from(outbox)
    .where(
      and(eq(outbox.userId, userId), eq(outbox.kind, "password_setup"), eq(outbox.state, "queued")),
    );
  for (const row of pending) await recordMailOutcome(row.id, "failed", "queued", tx);
}

export async function dispatchAccountMailQueue(
  database: AuthDatabase = currentAuthDatabase(),
): Promise<void> {
  const now = new Date();
  const interrupted = await database
    .select({ id: outbox.id })
    .from(outbox)
    .where(
      and(
        eq(outbox.state, "sending"),
        sql`${outbox.attemptStartedAt}<${new Date(now.getTime() - 60000).toISOString()}`,
      ),
    )
    .limit(100);
  for (const row of interrupted)
    await database.transaction((tx) => recordMailOutcome(row.id, "unknown", "sending", tx));
  const pending = await database
    .select({ id: outbox.id })
    .from(outbox)
    .where(eq(outbox.state, "queued"))
    .orderBy(asc(outbox.createdAt))
    .limit(10);
  for (const item of pending) {
    const [row] = await database
      .update(outbox)
      .set({ state: "sending", attemptStartedAt: new Date() })
      .where(and(eq(outbox.id, item.id), eq(outbox.state, "queued")))
      .returning();
    if (!row) continue;
    let outcome: "sent" | "failed" | "unknown" = "failed";
    try {
      if (row.expiresAt <= new Date() || !row.ciphertext || !row.iv || !row.tag)
        throw Error("Account mail expired");
      const message = openAccountMail(row.requestKey, row.kind, {
        ciphertext: row.ciphertext,
        iv: row.iv,
        tag: row.tag,
      });
      const [current] = await database
        .select({ userId: user.id, email: user.email, result: accountActionReceipt.result })
        .from(accountActionReceipt)
        .innerJoin(user, eq(user.id, accountActionReceipt.targetId))
        .where(eq(accountActionReceipt.key, row.requestKey));
      if (
        !current?.result ||
        current.userId !== row.userId ||
        message.disclosure?.userId !== row.userId ||
        typeof message.to !== "string" ||
        message.to.toLowerCase() !== current.email.toLowerCase()
      )
        throw Error("Account mail recipient changed");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          sendMail(message),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(Error("Account mail handoff timed out")), 30000);
            timer.unref();
          }),
        ]);
        outcome = "sent";
      } catch (error) {
        outcome = error instanceof MailDeliveryRefusedError ? "failed" : "unknown";
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch {
      /* No external send was attempted if decoding or expiry validation failed. */
    }
    await database.transaction((tx) => recordMailOutcome(row.id, outcome, "sending", tx));
  }
  await database
    .delete(outbox)
    .where(
      and(
        inArray(outbox.state, ["sent", "failed", "unknown"]),
        lt(outbox.createdAt, new Date(now.getTime() - 48 * 3600000)),
      ),
    );
}
export function startAccountMailWorker() {
  let stopped = false,
    active: Promise<void> | undefined;
  const tick = () => {
    if (!stopped && !active)
      active = dispatchAccountMailQueue()
        .catch(() => {})
        .finally(() => {
          active = undefined;
        });
  };
  const timer = setInterval(tick, 1000);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await active;
  };
}
