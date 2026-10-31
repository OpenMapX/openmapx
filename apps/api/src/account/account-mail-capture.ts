import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { accountMailOutbox } from "../db/schema";
import { configuredTrustedWebOrigins } from "../utils/csrf";
import type { MailOptions } from "../utils/email";
import { type AccountMailKind, sealAccountMail } from "./account-mail-outbox";
import type { AuthDatabase } from "./auth-database";

const capture = new AsyncLocalStorage<{
  requestKey: string;
  userId: string;
  kind: AccountMailKind;
  database: AuthDatabase;
  delivery?: "invitation" | "reset";
  count: number;
}>();
export async function captureAccountMail<T>(
  input: {
    requestKey: string;
    userId: string;
    kind: AccountMailKind;
    database: AuthDatabase;
    delivery?: "invitation" | "reset";
  },
  run: () => Promise<T>,
): Promise<T> {
  const owner = { ...input, count: 0 };
  return capture.run(owner, async () => {
    const result = await run();
    if (owner.count !== 1) throw Error("Account mail was not durably captured");
    return result;
  });
}
export async function enqueueCapturedAccountMail(message: MailOptions): Promise<boolean> {
  const owner = capture.getStore();
  if (!owner) return false;
  if (owner.count || message.disclosure?.userId !== owner.userId)
    throw Error("Account mail target changed");
  const id = randomUUID();
  await owner.database.insert(accountMailOutbox).values({
    id,
    requestKey: owner.requestKey,
    userId: owner.userId,
    kind: owner.kind,
    ...sealAccountMail(owner.requestKey, owner.kind, {
      ...message,
      disclosure: { ...message.disclosure, idempotencyKey: `account-mail:${id}` },
    }),
    expiresAt: new Date(Date.now() + 3600000),
  });
  owner.count++;
  return true;
}

export function capturedAccountPasswordLink(token: string): string | undefined {
  return capture.getStore()?.kind === "password_setup"
    ? `${configuredTrustedWebOrigins()[0]}/auth/password#token=${encodeURIComponent(token)}`
    : undefined;
}
export function isAccountSetupInvitation() {
  return capture.getStore()?.delivery === "invitation";
}
