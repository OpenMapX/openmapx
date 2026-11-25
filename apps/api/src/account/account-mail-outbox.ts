import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scryptSync } from "node:crypto";
import type { AccountMailKind } from "@openmapx/core/api-contracts";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { resolveBetterAuthSecret } from "../auth-secret";
import { accountActionReceipt, accountMailOutbox as outbox, user } from "../db/schema";
import { type MailOptions, sendMail } from "../utils/email";
import { MailDeliveryRefusedError } from "../utils/mail-outcome";
import { type AuthDatabase, currentAuthDatabase } from "./auth-database";

interface SealedMail {
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: number;
}
/** The version of the outbox key that `sealAccountMail` uses. */
const ACCOUNT_MAIL_KEY_VERSION = 1;
const key = (purpose = "encrypted-mail-outbox") =>
  Buffer.from(
    hkdfSync("sha256", resolveBetterAuthSecret(), "openmapx-account-mail-v1", purpose, 32),
  );
/**
 * An action's intent can carry a password, so it is digested with a slow KDF
 * rather than a fast MAC. The derived key salts it, keeping the digest
 * deterministic for idempotency; account actions are rare enough to afford it.
 */
export const accountActionDigest = (value: unknown) =>
  scryptSync(JSON.stringify(value), key("account-action-receipts"), 32, {
    N: 16384,
    r: 8,
    p: 1,
  }).toString("hex");
/** Binds the sealed mail to its outbox row, whose natural key is the request and the kind. */
const aad = (requestKey: string, kind: AccountMailKind) =>
  Buffer.from(`account_mail_outbox:${requestKey}:${kind}`, "utf8");
export function sealAccountMail(
  requestKey: string,
  kind: AccountMailKind,
  mail: MailOptions,
): SealedMail {
  const bytes = Buffer.from(JSON.stringify(mail));
  if (bytes.length > 65536) throw Error("Account mail exceeds supported size");
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(aad(requestKey, kind));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    keyVersion: ACCOUNT_MAIL_KEY_VERSION,
  };
}
export function openAccountMail(
  requestKey: string,
  kind: AccountMailKind,
  sealed: SealedMail,
): MailOptions {
  if (sealed.keyVersion !== ACCOUNT_MAIL_KEY_VERSION)
    throw Error("Unsupported account mail key version");
  const cipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(sealed.iv, "base64"));
  cipher.setAAD(aad(requestKey, kind));
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
  expectedStatus: "queued" | "sending",
  tx: AuthDatabase,
) {
  const [row] = await tx
    .update(outbox)
    .set({
      status: outcome,
      finishedAt: new Date(),
      ciphertext: null,
      iv: null,
      tag: null,
      keyVersion: null,
    })
    .where(and(eq(outbox.id, id), eq(outbox.status, expectedStatus)))
    .returning({ requestKey: outbox.requestKey, kind: outbox.kind });
  if (!row) return;
  const field =
    row.kind === "email_verification" ? "{verificationDelivery}" : "{passwordSetupDelivery}";
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
      and(
        eq(outbox.userId, userId),
        eq(outbox.kind, "password_setup"),
        eq(outbox.status, "queued"),
      ),
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
        eq(outbox.status, "sending"),
        sql`${outbox.attemptStartedAt}<${new Date(now.getTime() - 60000).toISOString()}`,
      ),
    )
    .limit(100);
  for (const row of interrupted)
    await database.transaction((tx) => recordMailOutcome(row.id, "unknown", "sending", tx));
  const pending = await database
    .select({ id: outbox.id })
    .from(outbox)
    .where(eq(outbox.status, "queued"))
    .orderBy(asc(outbox.createdAt))
    .limit(10);
  for (const item of pending) {
    const [row] = await database
      .update(outbox)
      .set({ status: "sending", attemptStartedAt: new Date() })
      .where(and(eq(outbox.id, item.id), eq(outbox.status, "queued")))
      .returning();
    if (!row) continue;
    let outcome: "sent" | "failed" | "unknown" = "failed";
    try {
      if (
        row.expiresAt <= new Date() ||
        !row.ciphertext ||
        !row.iv ||
        !row.tag ||
        row.keyVersion === null
      )
        throw Error("Account mail expired");
      const message = openAccountMail(row.requestKey, row.kind, {
        ciphertext: row.ciphertext,
        iv: row.iv,
        tag: row.tag,
        keyVersion: row.keyVersion,
      });
      const [current] = await database
        .select({ userId: user.id, email: user.email, result: accountActionReceipt.result })
        .from(accountActionReceipt)
        .innerJoin(user, eq(user.id, accountActionReceipt.targetUserId))
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
        inArray(outbox.status, ["sent", "failed", "unknown"]),
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
