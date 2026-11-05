import { randomBytes } from "node:crypto";
import {
  type AccountDelivery,
  type AccountProvisioningResult,
  accountDeliverySchema,
  accountMailActionSchema,
  accountRoleChangeSchema,
  assistedAccountPasswordSchema,
  assistedAccountVerifySchema,
  provisionAccountSchema,
} from "@openmapx/core/api-contracts";
import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { auth, withAuthOperation } from "../auth";
import type { AccountAction } from "../db/account-provisioning-schema";
import { accountActionReceipt, accountMailOutbox, session, user, verification } from "../db/schema";
import { writeAuditLog } from "../utils/audit-log";
import { configuredTrustedWebOrigins } from "../utils/csrf";
import { captureAccountMail } from "./account-mail-capture";
import { accountActionDigest, supersedeQueuedPasswordSetup } from "./account-mail-outbox";
import { type AccountRole, changeAccountRole, withAccountMutation } from "./account-mutations";
import { withAccountRecoveryProof } from "./account-recovery-context";
import { type AuthDatabase, currentAuthDatabase } from "./auth-database";
export interface AccountActor {
  id: string;
  sessionId: string;
  headers: Headers;
}
export class AccountProvisioningError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 409,
  ) {
    super(code);
  }
}
function fail(code: string, status = 409): never {
  throw new AccountProvisioningError(code, status);
}
async function resultFor(
  key: string,
  database: AuthDatabase,
): Promise<AccountProvisioningResult & { role?: AccountRole; changed?: boolean }> {
  const [receipt] = await database
    .select()
    .from(accountActionReceipt)
    .where(eq(accountActionReceipt.key, key));
  if (!receipt?.targetId || !receipt.result) fail("ACCOUNT_ACTION_NOT_AVAILABLE");
  const mails = await database
    .select({ kind: accountMailOutbox.kind, state: accountMailOutbox.state })
    .from(accountMailOutbox)
    .where(eq(accountMailOutbox.requestKey, key));
  const outcome = (kind: "verification" | "password_setup") => {
    const state = mails.find((row) => row.kind === kind)?.state;
    return state === "sending"
      ? "queued"
      : (state ??
          (kind === "verification"
            ? receipt.result?.verificationDelivery
            : receipt.result?.passwordSetupDelivery) ??
          "not_requested");
  };
  return {
    userId: receipt.targetId,
    created: receipt.result.created,
    verificationDelivery: outcome("verification"),
    passwordSetupDelivery: outcome("password_setup"),
    ...(receipt.result.role ? { role: receipt.result.role, changed: receipt.result.changed } : {}),
  };
}
/** Read-only status of the latest administrative mail request; never reissues mail. */
export async function accountDelivery(
  actor: AccountActor,
  userId: string,
  database: AuthDatabase = currentAuthDatabase(),
): Promise<AccountDelivery> {
  const [live] = await database
    .select({ session, user })
    .from(session)
    .innerJoin(user, eq(user.id, session.userId))
    .where(eq(session.id, actor.sessionId));
  if (
    !live ||
    live.user.id !== actor.id ||
    live.user.role !== "admin" ||
    live.user.banned ||
    live.session.expiresAt <= new Date() ||
    live.session.impersonatedBy
  )
    fail("FULL_ADMIN_SESSION_REQUIRED", 403);
  const [subject] = await database.select({ id: user.id }).from(user).where(eq(user.id, userId));
  if (!subject) fail("ACCOUNT_NOT_FOUND", 404);
  const [receipt] = await database
    .select()
    .from(accountActionReceipt)
    .where(
      and(
        eq(accountActionReceipt.targetId, userId),
        eq(accountActionReceipt.mailRequested, true),
        inArray(accountActionReceipt.action, [
          "create",
          "invitation",
          "verification-email",
          "reset-password",
        ]),
      ),
    )
    .orderBy(desc(accountActionReceipt.createdAt), desc(accountActionReceipt.key))
    .limit(1);
  if (!receipt) return { latest: null };
  const result = await resultFor(receipt.key, database);
  return accountDeliverySchema.parse({
    latest: {
      action: receipt.action,
      requestedAt: receipt.createdAt.toISOString(),
      verificationDelivery: result.verificationDelivery,
      passwordSetupDelivery: result.passwordSetupDelivery,
    },
  });
}
async function withAccountAction(
  input: {
    action: AccountAction;
    targetId: string | null;
    semantic: unknown;
    actor: AccountActor;
    idempotencyKey: string;
    mailRequested: boolean;
    role?: AccountRole;
  },
  run: (
    tx: AuthDatabase,
    key: string,
  ) => Promise<{ userId: string; created: boolean; role?: AccountRole; changed?: boolean }>,
  database: AuthDatabase = currentAuthDatabase(),
) {
  const key = accountActionDigest(["key", input.actor.id, input.idempotencyKey]),
    digest = accountActionDigest(["intent", input.action, input.targetId, input.semantic]);
  return withAuthOperation(() =>
    withAccountMutation(
      {
        actorId: input.actor.id,
        targetId: input.targetId,
        action:
          input.action === "create"
            ? "create"
            : input.action === "verify"
              ? "verify"
              : input.action === "password"
                ? "password"
                : input.action === "role"
                  ? "role"
                  : "mail",
        role: input.role,
        mutationKey: input.idempotencyKey,
      },
      async (tx) => {
        const [liveSession] = await tx
          .select()
          .from(session)
          .where(eq(session.id, input.actor.sessionId))
          .for("share");
        if (
          !liveSession ||
          liveSession.userId !== input.actor.id ||
          liveSession.expiresAt <= new Date() ||
          liveSession.impersonatedBy
        )
          fail("FULL_ADMIN_SESSION_REQUIRED", 403);
        const [prior] = await tx
          .select()
          .from(accountActionReceipt)
          .where(eq(accountActionReceipt.key, key));
        if (prior) {
          if (
            prior.actorId !== input.actor.id ||
            prior.intentDigest !== digest ||
            prior.action !== input.action
          )
            fail("ACCOUNT_ACTION_CONFLICT");
          return resultFor(key, tx);
        }
        if (input.mailRequested) {
          const cutoff = new Date(Date.now() - 3600000).toISOString(),
            [counts] = await tx
              .select({
                actor: sql<number>`count(*) filter(where ${accountActionReceipt.actorId}=${input.actor.id})::int`,
                target: sql<number>`count(*) filter(where ${accountActionReceipt.targetId}=${input.targetId})::int`,
              })
              .from(accountActionReceipt)
              .where(
                and(
                  eq(accountActionReceipt.mailRequested, true),
                  sql`${accountActionReceipt.createdAt}>${cutoff}`,
                ),
              );
          if ((counts?.actor ?? 0) >= 20 || (input.targetId && (counts?.target ?? 0) >= 3))
            fail("ACCOUNT_MAIL_RATE_LIMITED", 429);
        }
        await tx.insert(accountActionReceipt).values({
          key,
          actorId: input.actor.id,
          targetId: input.targetId,
          action: input.action,
          intentDigest: digest,
          mailRequested: input.mailRequested,
        });
        const result = await run(tx, key);
        const queued = await tx
          .select({ kind: accountMailOutbox.kind })
          .from(accountMailOutbox)
          .where(eq(accountMailOutbox.requestKey, key));
        await tx
          .update(accountActionReceipt)
          .set({
            targetId: result.userId,
            result: {
              created: result.created,
              verificationDelivery: queued.some((mail) => mail.kind === "verification")
                ? "queued"
                : "not_requested",
              passwordSetupDelivery: queued.some((mail) => mail.kind === "password_setup")
                ? "queued"
                : "not_requested",
              ...(result.role ? { role: result.role, changed: result.changed } : {}),
            },
          })
          .where(eq(accountActionReceipt.key, key));
        return resultFor(key, tx);
      },
      database,
    ),
  );
}
async function issueAccountMail(
  tx: AuthDatabase,
  key: string,
  subject: { id: string; email: string; emailVerified: boolean },
  kind: "verification" | "password_setup",
  invitation = false,
) {
  const origin = configuredTrustedWebOrigins()[0];
  if (kind === "password_setup") {
    await tx
      .delete(verification)
      .where(
        and(eq(verification.value, subject.id), like(verification.identifier, "reset-password:%")),
      );
    await supersedeQueuedPasswordSetup(subject.id, tx);
  }
  await captureAccountMail(
    {
      requestKey: key,
      userId: subject.id,
      kind,
      database: tx,
      delivery: invitation ? "invitation" : "reset",
    },
    () =>
      kind === "verification"
        ? auth.api.sendVerificationEmail({
            body: { email: subject.email, callbackURL: `${origin}/` },
          })
        : auth.api.requestPasswordReset({
            body: { email: subject.email, redirectTo: `${origin}/auth/password` },
          }),
  );
}
export async function provisionAccount(
  input: {
    name: string;
    email: string;
    role: "user" | "admin" | "privacy_admin";
    password?: string;
    sendInvitation: boolean;
    idempotencyKey: string;
    actor: AccountActor;
  },
  database: AuthDatabase = currentAuthDatabase(),
): Promise<AccountProvisioningResult> {
  const body = provisionAccountSchema.parse({
      name: input.name,
      email: input.email,
      role: input.role,
      password: input.password,
      sendInvitation: input.sendInvitation,
    }),
    invite = body.sendInvitation || !body.password;
  return withAccountAction(
    {
      action: "create",
      targetId: null,
      semantic: body,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      mailRequested: invite,
    },
    async (tx, key) => {
      const headers = new Headers(input.actor.headers);
      headers.set("idempotency-key", input.idempotencyKey);
      const created = await auth.api.createUser({
        headers,
        body: {
          name: body.name,
          email: body.email,
          password: body.password ?? randomBytes(96).toString("base64url"),
          data: { role: body.role },
        },
      });
      const [subject] = await tx.select().from(user).where(eq(user.id, created.user.id));
      if (!subject || subject.emailVerified) fail("ACCOUNT_CREATION_FAILED", 503);
      if (invite) {
        await issueAccountMail(tx, key, subject, "verification");
        await issueAccountMail(tx, key, subject, "password_setup", true);
      }
      return { userId: subject.id, created: true };
    },
    database,
  );
}

export async function assistedAccountAction(
  input: {
    action: "invitation" | "verification-email" | "reset-password" | "verify" | "password";
    userId: string;
    body: unknown;
    idempotencyKey: string;
    actor: AccountActor;
    proof?: { challengeId: string; nonce: Buffer | string };
  },
  database: AuthDatabase = currentAuthDatabase(),
): Promise<AccountProvisioningResult> {
  const verifyBody =
      input.action === "verify" ? assistedAccountVerifySchema.parse(input.body) : undefined,
    passwordBody =
      input.action === "password" ? assistedAccountPasswordSchema.parse(input.body) : undefined,
    body = verifyBody ?? passwordBody ?? accountMailActionSchema.parse(input.body),
    mail = ["invitation", "verification-email", "reset-password"].includes(input.action);
  return withAccountAction(
    {
      action: input.action,
      targetId: input.userId,
      semantic: body,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      mailRequested: mail,
    },
    async (tx, key) => {
      const [subject] = await tx.select().from(user).where(eq(user.id, input.userId));
      if (!subject) fail("ACCOUNT_NOT_FOUND", 404);
      if (verifyBody && verifyBody.expectedEmail.toLowerCase() !== subject.email.toLowerCase())
        fail("ACCOUNT_EMAIL_CHANGED");
      if (!input.proof) fail("REAUTHENTICATION_REQUIRED", 403);
      const purpose =
        input.action === "verify"
          ? "account.verify"
          : input.action === "password"
            ? "account.password.set"
            : input.action === "reset-password"
              ? "account.reset.send"
              : "account.invite";
      return withAccountRecoveryProof(
        {
          actorId: input.actor.id,
          targetId: input.userId,
          purpose,
          ...input.proof,
          sessionId: input.actor.sessionId,
        },
        tx,
        async () => {
          if (input.action === "verify") {
            await tx
              .update(user)
              .set({ emailVerified: true, updatedAt: new Date() })
              .where(eq(user.id, subject.id));
            await tx.delete(session).where(eq(session.userId, subject.id));
          } else if (input.action === "password") {
            if (!passwordBody) fail("INVALID_ACCOUNT_ACTION", 400);
            const headers = new Headers(input.actor.headers);
            headers.set("idempotency-key", input.idempotencyKey);
            await auth.api.setUserPassword({
              headers,
              body: { userId: subject.id, newPassword: passwordBody.password },
            });
            await tx.delete(session).where(eq(session.userId, subject.id));
            await tx
              .delete(verification)
              .where(
                and(
                  eq(verification.value, subject.id),
                  like(verification.identifier, "reset-password:%"),
                ),
              );
          } else {
            if (input.action !== "reset-password" && !subject.emailVerified)
              await issueAccountMail(tx, key, subject, "verification");
            if (input.action !== "verification-email")
              await issueAccountMail(
                tx,
                key,
                subject,
                "password_setup",
                input.action === "invitation",
              );
          }
          await writeAuditLog({
            actorId: input.actor.id,
            targetId: subject.id,
            targetType: "user",
            action: input.action === "password" ? "user.password.set" : `user.${input.action}`,
            details: {
              mutationDigest: key,
              ...("reasonCode" in body ? { reasonCode: body.reasonCode } : {}),
            },
          });
          return { userId: subject.id, created: false };
        },
      );
    },
    database,
  );
}

export async function changeProvisionedAccountRole(
  input: { userId: string; body: unknown; actor: AccountActor; idempotencyKey: string },
  database: AuthDatabase = currentAuthDatabase(),
) {
  const body = accountRoleChangeSchema.parse(input.body),
    result = await withAccountAction(
      {
        action: "role",
        targetId: input.userId,
        semantic: body,
        actor: input.actor,
        idempotencyKey: input.idempotencyKey,
        mailRequested: false,
        role: body.role,
      },
      async (tx) => {
        const change = await changeAccountRole(
          {
            actorId: input.actor.id,
            userId: input.userId,
            role: body.role,
            expectedRole: body.expectedRole,
            idempotencyKey: input.idempotencyKey,
          },
          tx,
        );
        return { ...change, created: false };
      },
      database,
    );
  if (!result.role || result.changed === undefined) fail("ACCOUNT_ACTION_NOT_AVAILABLE", 503);
  return { userId: result.userId, role: result.role, changed: result.changed };
}
