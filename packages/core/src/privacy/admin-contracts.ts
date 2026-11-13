import z from "zod/v4";

export const privacyStableCodeSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/)
  .max(128);
const stableCode = privacyStableCodeSchema;

export const privacyCaseVersionSchema = z.strictObject({ version: z.number().int().positive() });

/** Resolves one operator-held source. The reason code records what the
 * operator checked; nothing else about the source is stored. */
export const privacyTaskResolutionSchema = privacyCaseVersionSchema.extend({
  reasonCode: stableCode,
});

/** Records that the operator checked the requester's identity outside the
 * system. The reason code names how it was checked. */
export const privacyIdentityVerificationSchema = privacyCaseVersionSchema.extend({
  reasonCode: stableCode,
});

export const privacyCaseDecisionSchema = privacyCaseVersionSchema.extend({
  decision: z.enum(["in_progress", "waiting_on_requester", "completed", "refused"]),
  reasonCode: stableCode,
});

export const privacyCaseExtensionSchema = privacyCaseVersionSchema.extend({
  extendedUntil: z.iso.datetime({ offset: true }),
  extensionNotifiedAt: z.iso.datetime({ offset: true }),
  reasonCode: stableCode,
});
