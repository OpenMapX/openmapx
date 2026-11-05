import z from "zod/v4";

const uuid = z.uuid();
export const privacyStableCodeSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/)
  .max(128);
const stableCode = privacyStableCodeSchema;
export const identityReviewSchema = z
  .object({
    version: z.number().int().positive(),
    party: z.enum(["subject", "representative"]),
    outcome: z.enum(["verified", "failed", "clarification"]),
    method: z
      .enum(["account_login", "verified_email_challenge", "exceptional_evidence"])
      .optional(),
    reasonableDoubtCode: stableCode.optional(),
    evidenceAttachmentId: uuid.optional(),
    authorityOutcome: z.enum(["pending", "approved", "rejected"]).optional(),
    authorityAttachmentId: uuid.optional(),
    deliveryAuthorized: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.outcome === "verified" &&
      !value.method &&
      !(value.party === "representative" && value.authorityOutcome !== undefined)
    )
      ctx.addIssue({ code: "custom", path: ["method"], message: "verification method required" });
    if (
      value.method === "exceptional_evidence" &&
      (!value.reasonableDoubtCode || !value.evidenceAttachmentId)
    )
      ctx.addIssue({
        code: "custom",
        path: ["evidenceAttachmentId"],
        message: "exceptional evidence requires reasonable doubt and an attachment",
      });
    if (value.party === "representative") {
      if (value.authorityOutcome === "approved" && !value.authorityAttachmentId)
        ctx.addIssue({
          code: "custom",
          path: ["authorityAttachmentId"],
          message: "authority evidence required",
        });
      if (value.deliveryAuthorized && value.authorityOutcome !== "approved")
        ctx.addIssue({
          code: "custom",
          path: ["deliveryAuthorized"],
          message: "representative delivery requires approved authority",
        });
    } else if (
      value.authorityOutcome !== undefined ||
      value.authorityAttachmentId !== undefined ||
      value.deliveryAuthorized !== undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["party"],
        message: "authority applies to representative",
      });
    }
  });
export const taskAssignmentSchema = z
  .object({
    version: z.number().int().positive(),
    assignedTo: z.string().min(1).max(256).nullable(),
  })
  .strict();
export const assistedReauthStartSchema = z
  .object({
    channel: z.enum(["assisted", "representative"]).default("assisted"),
    reasonCode: stableCode,
  })
  .strict();

export const emailIdentityChallengeIssueSchema = z
  .object({ party: z.enum(["subject", "representative"]) })
  .strict();

export const emailIdentityChallengeCompleteSchema = z
  .object({
    party: z.enum(["subject", "representative"]),
    code: z.string().regex(/^\d{6}$/),
  })
  .strict();

export const taskDecisionSchema = z
  .object({
    version: z.number().int().positive(),
    status: z.enum(["complete", "not_applicable", "operator_review", "retryable", "canceled"]),
    reasonCode: stableCode.optional(),
    redactionCode: stableCode.optional(),
    recordCount: z.number().int().min(0).max(10_000_000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      ["not_applicable", "operator_review", "canceled"].includes(value.status) &&
      !value.reasonCode
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["reasonCode"],
        message: "decision requires a reason code",
      });
    }
  });

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const attachmentPurposeSchema = z.enum([
  "identity_evidence",
  "representative_authority",
  "processor_response",
  "operator_supplement",
]);
export const attachmentMediaTypeSchema = z.enum([
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/json",
  "image/png",
  "image/jpeg",
]);
export type AttachmentPurpose = z.infer<typeof attachmentPurposeSchema>;

/** Provenance is metadata only; the supplied document remains encrypted and
 * is never copied into this JSON object. Keeping a strict allowlist prevents a
 * caller from smuggling personal notes or credentials into case telemetry. */
export const attachmentMetadataSchema = z
  .object({
    source: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
      .optional(),
    controller: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
      .optional(),
    processor: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
      .optional(),
    cutoff: z.iso.datetime({ offset: true }).optional(),
    reasonCode: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/)
      .optional(),
    redactionCode: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/)
      .optional(),
    schemaVersion: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.source && !value.controller && !value.processor) {
      ctx.addIssue({
        code: "custom",
        path: ["source"],
        message: "attachment provenance requires a source",
      });
    }
    if (JSON.stringify(value).length > 2_048) {
      ctx.addIssue({
        code: "custom",
        path: ["source"],
        message: "attachment metadata is too large",
      });
    }
  });
export type AttachmentMetadata = z.infer<typeof attachmentMetadataSchema>;

export const attachmentFilenameSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._ -]*$/)
  .refine(
    (value) => !/\.(?:exe|dll|js|mjs|html?|svg|zip|tar|gz|7z|rar|docm|xlsm)$/iu.test(value),
    "active or archive attachments are not permitted",
  );

export const privacyCaseVersionSchema = z.strictObject({ version: z.number().int().positive() });
export const privacyCaseDecisionSchema = privacyCaseVersionSchema.extend({
  decision: z.enum(["refused", "clarification_needed", "operator_review"]),
  reasonCode: stableCode,
});
export const privacyCaseExtensionSchema = privacyCaseVersionSchema.extend({
  extendedUntil: z.iso.datetime({ offset: true }),
  extensionNotifiedAt: z.iso.datetime({ offset: true }),
  reasonCode: stableCode,
});
export const privacyAttachmentUploadSchema = privacyCaseVersionSchema
  .extend({
    purpose: attachmentPurposeSchema,
    filename: attachmentFilenameSchema,
    mediaType: attachmentMediaTypeSchema,
    contentBase64: z
      .string()
      .min(4)
      .max(Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .refine((value) => value.length % 4 === 0, "base64 length must be divisible by four"),
    metadata: attachmentMetadataSchema.optional(),
  })
  .superRefine((v, c) => {
    if (!["identity_evidence", "representative_authority"].includes(v.purpose) && !v.metadata)
      c.addIssue({ code: "custom", message: "supplement provenance required" });
  });
export const privacyAttachmentReviewSchema = privacyCaseVersionSchema.extend({
  decision: z.enum(["approved", "rejected"]),
  reasonCode: stableCode,
});
export const privacyBackupReviewRequestSchema = z.strictObject({
  backupId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
});
