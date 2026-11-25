import { createHash } from "node:crypto";
import {
  type AuthPolicySettings,
  type AuthPolicySnapshot,
  auditEntry,
  authPolicyApplySchema,
  authPolicySettingsSchema,
} from "@openmapx/core/api-contracts";
import { and, eq, sql } from "drizzle-orm";
import {
  adminAuditLog,
  authPolicyApplication,
  authPolicyState,
  systemSetting,
  user,
} from "../db/schema";
import { settingDefinition, settingFromEnvironment } from "../services/settings";
import { actorUserIdOrNull } from "../utils/actor";
import { type AuthDatabase, currentAuthDatabase } from "./auth-database";
export const defaultAuthPolicySettings: Readonly<AuthPolicySettings> = Object.freeze({
  emailVerificationRequired: true,
  sessionDurationHours: 168,
  twoFaEnabled: true,
  passwordMinLength: 8,
});
/** The system setting that holds the pending draft of each policy field. */
export const AUTH_POLICY_SETTINGS = Object.freeze({
  emailVerificationRequired: "auth.emailVerificationRequired",
  sessionDurationHours: "auth.sessionDurationHours",
  twoFaEnabled: "auth.twoFaEnabled",
  passwordMinLength: "auth.passwordMinLength",
} as const satisfies Record<keyof AuthPolicySettings, string>);
/** The setting keys of the pending authentication policy draft. */
export const authPolicyKeys: readonly string[] = Object.freeze(Object.values(AUTH_POLICY_SETTINGS));
/** Policy fields from values keyed by their system setting. */
export function authPolicyDraft(
  values: Readonly<Record<string, unknown>>,
): Partial<Record<keyof AuthPolicySettings, unknown>> {
  return Object.fromEntries(
    (Object.entries(AUTH_POLICY_SETTINGS) as [keyof AuthPolicySettings, string][])
      .filter(([, key]) => Object.hasOwn(values, key))
      .map(([field, key]) => [field, values[key]]),
  );
}
/** The environment's value of email verification, if it sets one. */
function emailVerificationFromEnvironment(): boolean | undefined {
  try {
    return settingFromEnvironment(
      settingDefinition(AUTH_POLICY_SETTINGS.emailVerificationRequired),
    ) as boolean | undefined;
  } catch {
    throw new AuthPolicyError("AUTH_POLICY_INVALID");
  }
}
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
  const fromEnvironment = activationVersion === 1 ? emailVerificationFromEnvironment() : undefined;
  if (fromEnvironment !== undefined) effective.emailVerificationRequired = fromEnvironment;
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
  database: Pick<AuthDatabase, "select"> = currentAuthDatabase(),
): Promise<AuthPolicySnapshot> {
  try {
    const rows = await database.select().from(authPolicyState).where(eq(authPolicyState.id, 1));
    // The stored row is the activation: no row means the defaults were never activated.
    const row = rows[0];
    if (!row) return unactivatedAuthPolicy;
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
    rows = await database.select().from(systemSetting);
  return {
    active,
    pending: authPolicyDraft(Object.fromEntries(rows.map((r) => [r.key, r.value]))),
    ownership: {
      emailVerificationRequired:
        active.activationVersion === 1 && emailVerificationFromEnvironment() !== undefined
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
    intentDigest = digest(request),
    applicationKey = digest([actorId, request.idempotencyKey]);
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
      .where(eq(authPolicyApplication.key, applicationKey));
    if (prior) {
      if (prior.actorUserId !== actorId || prior.intentDigest !== intentDigest)
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
        settings: request.settings,
        revision: stored.revision,
        activatedByUserId: actorId,
      })
      .onConflictDoUpdate({
        target: authPolicyState.id,
        set: {
          settings: request.settings,
          revision: stored.revision,
          activatedByUserId: actorId,
          activatedAt: new Date(),
        },
      });
    for (const [field, value] of Object.entries(request.settings) as [
      keyof AuthPolicySettings,
      unknown,
    ][])
      await tx
        .insert(systemSetting)
        .values({
          key: AUTH_POLICY_SETTINGS[field],
          value,
          updatedByUserId: actorUserIdOrNull(actorId),
        })
        .onConflictDoUpdate({
          target: systemSetting.key,
          set: { value, updatedByUserId: actorUserIdOrNull(actorId), updatedAt: new Date() },
        });
    await tx.insert(adminAuditLog).values({
      actorUserId: actorId,
      ...auditEntry("auth.policy.apply"),
      targetId: result.revision,
      details: { revision: result.revision, activationVersion: 1 },
    });
    await tx
      .insert(authPolicyApplication)
      .values({ key: applicationKey, actorUserId: actorId, intentDigest, snapshot: result });
    return result;
  });
}
