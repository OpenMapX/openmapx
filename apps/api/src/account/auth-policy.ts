import { createHash, randomUUID } from "node:crypto";
import {
  type AuthPolicySettings,
  type AuthPolicySnapshot,
  authPolicyApplySchema,
  authPolicySettingsSchema,
} from "@openmapx/core/api-contracts";
import { and, eq, sql } from "drizzle-orm";
import {
  adminAuditLog,
  authPolicyApplication,
  authPolicyState,
  systemSettings,
  user,
} from "../db/schema";
import { type AuthDatabase, currentAuthDatabase } from "./auth-database";
export const defaultAuthPolicySettings: Readonly<AuthPolicySettings> = Object.freeze({
  emailVerificationRequired: true,
  sessionDurationHours: 168,
  twoFaEnabled: true,
  passwordMinLength: 8,
});
export const authPolicyKeys = Object.freeze(Object.keys(defaultAuthPolicySettings));
export class AuthPolicyError extends Error {
  constructor(
    readonly code:
      | "AUTH_POLICY_INVALID"
      | "AUTH_POLICY_UNAVAILABLE"
      | "AUTH_POLICY_CONFLICT"
      | "AUTH_POLICY_FORBIDDEN",
  ) {
    super(code);
  }
}
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
function snapshot(settings: AuthPolicySettings, activationVersion: 0 | 1): AuthPolicySnapshot {
  const effective = { ...settings };
  if (activationVersion === 1 && process.env.AUTH_EMAIL_VERIFICATION !== undefined) {
    const raw = process.env.AUTH_EMAIL_VERIFICATION;
    if (!["true", "false", "1", "0"].includes(raw))
      throw new AuthPolicyError("AUTH_POLICY_INVALID");
    effective.emailVerificationRequired = raw === "true" || raw === "1";
  }
  return Object.freeze({
    ...effective,
    activationVersion,
    revision: digest([
      activationVersion,
      effective.emailVerificationRequired,
      effective.sessionDurationHours,
      effective.twoFaEnabled,
      effective.passwordMinLength,
    ]),
  });
}
export const unactivatedAuthPolicy = snapshot(defaultAuthPolicySettings, 0);
export async function loadAuthPolicy(
  database: AuthDatabase = currentAuthDatabase(),
): Promise<AuthPolicySnapshot> {
  try {
    const rows = await database.select().from(authPolicyState).where(eq(authPolicyState.id, 1));
    if (!rows.length) return unactivatedAuthPolicy;
    const row = rows[0];
    if (!row || row.activationVersion !== 1) throw new AuthPolicyError("AUTH_POLICY_INVALID");
    const parsed = authPolicySettingsSchema.safeParse(row.settings);
    if (!parsed.success) throw new AuthPolicyError("AUTH_POLICY_INVALID");
    const stored = snapshotWithoutEnv(parsed.data);
    if (row.revision !== stored.revision) throw new AuthPolicyError("AUTH_POLICY_INVALID");
    return snapshot(parsed.data, 1);
  } catch (error) {
    if (error instanceof AuthPolicyError) throw error;
    throw new AuthPolicyError("AUTH_POLICY_UNAVAILABLE");
  }
}
function snapshotWithoutEnv(s: AuthPolicySettings): AuthPolicySnapshot {
  return Object.freeze({
    ...s,
    activationVersion: 1,
    revision: digest([
      1,
      s.emailVerificationRequired,
      s.sessionDurationHours,
      s.twoFaEnabled,
      s.passwordMinLength,
    ]),
  });
}
export async function authPolicyView(database: AuthDatabase = currentAuthDatabase()) {
  const active = await loadAuthPolicy(database),
    rows = await database.select().from(systemSettings);
  return {
    active,
    pending: Object.fromEntries(
      rows.filter((r) => authPolicyKeys.includes(r.key)).map((r) => [r.key, r.value]),
    ),
    ownership: {
      emailVerificationRequired:
        active.activationVersion === 1 && process.env.AUTH_EMAIL_VERIFICATION !== undefined
          ? ("env" as const)
          : active.activationVersion === 1
            ? ("database" as const)
            : ("default" as const),
      sessionDurationHours:
        active.activationVersion === 1 ? ("database" as const) : ("default" as const),
      twoFaEnabled: active.activationVersion === 1 ? ("database" as const) : ("default" as const),
      passwordMinLength:
        active.activationVersion === 1 ? ("database" as const) : ("default" as const),
    },
  };
}
export async function applyAuthPolicy(
  input: unknown,
  actorId: string,
  database: AuthDatabase = currentAuthDatabase(),
): Promise<AuthPolicySnapshot> {
  const parsed = authPolicyApplySchema.safeParse(input);
  if (!parsed.success) throw new AuthPolicyError("AUTH_POLICY_INVALID");
  const request = parsed.data,
    intentDigest = digest(request);
  return database.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(163578142, 1)`);
    const [actor] = await tx
      .select()
      .from(user)
      .where(and(eq(user.id, actorId), eq(user.banned, false)))
      .for("update");
    if (actor?.role !== "admin") throw new AuthPolicyError("AUTH_POLICY_FORBIDDEN");
    const [prior] = await tx
      .select()
      .from(authPolicyApplication)
      .where(eq(authPolicyApplication.key, request.idempotencyKey));
    if (prior) {
      if (prior.actorId !== actorId || prior.intentDigest !== intentDigest)
        throw new AuthPolicyError("AUTH_POLICY_CONFLICT");
      return Object.freeze(prior.snapshot);
    }
    const active = await loadAuthPolicy(tx);
    if (active.revision !== request.expectedRevision)
      throw new AuthPolicyError("AUTH_POLICY_CONFLICT");
    const result = snapshot(request.settings, 1),
      stored = snapshotWithoutEnv(request.settings);
    if (result.emailVerificationRequired !== request.settings.emailVerificationRequired)
      throw new AuthPolicyError("AUTH_POLICY_CONFLICT");
    await tx
      .insert(authPolicyState)
      .values({
        id: 1,
        activationVersion: 1,
        settings: request.settings,
        revision: stored.revision,
        activatedBy: actorId,
      })
      .onConflictDoUpdate({
        target: authPolicyState.id,
        set: {
          settings: request.settings,
          revision: stored.revision,
          activatedBy: actorId,
          activatedAt: new Date(),
        },
      });
    for (const [key, value] of Object.entries(request.settings))
      await tx
        .insert(systemSettings)
        .values({ key, value, updatedBy: actorId })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { value, updatedBy: actorId, updatedAt: new Date() },
        });
    await tx.insert(adminAuditLog).values({
      id: randomUUID(),
      actorId,
      targetType: "auth-policy",
      targetId: result.revision,
      action: "auth.policy.apply",
      details: { revision: result.revision, activationVersion: 1 },
    });
    await tx
      .insert(authPolicyApplication)
      .values({ key: request.idempotencyKey, actorId, intentDigest, snapshot: result });
    return result;
  });
}
