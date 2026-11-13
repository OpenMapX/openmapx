import { isValidRequestTransition } from "@openmapx/core/privacy";
import { defaultLocale } from "@openmapx/i18n";
import z from "zod/v4";
import { REQUEST_CHANNELS, REQUEST_KINDS, type RequestState } from "../db/privacy-schema.js";
import { PrivacyRequestError } from "./errors.js";

export const requestKindSchema = z.enum(REQUEST_KINDS);
export const requestChannelSchema = z.enum(REQUEST_CHANNELS);

export const assistedSubjectSchema = z
  .object({
    locatorType: z.enum(["user_id", "email", "username", "erasure_reference", "other_reference"]),
    locator: z.string().trim().min(1).max(512),
    accountState: z.enum(["current", "inaccessible", "deleted", "unknown"]),
  })
  .strict();

const localeSchema = z
  .string()
  .max(64)
  .regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/)
  .refine((locale) => {
    try {
      return Intl.getCanonicalLocales(locale).length === 1;
    } catch {
      return false;
    }
  }, "Invalid language tag")
  .default(defaultLocale);
const timeZoneSchema = z.string().min(1).max(64).default("UTC");

export const createSubjectRequestSchema = z
  .object({
    kind: requestKindSchema.default("access_and_portability"),
    channel: requestChannelSchema.default("self_service"),
    userId: z.string().min(1).max(256).nullable().optional().default(null),
    subject: assistedSubjectSchema.optional(),
    actorUserId: z.string().min(1).max(256).nullable().optional(),
    actorSessionId: z.string().min(1).max(256).nullable().optional(),
    receivedAt: z.coerce.date().optional(),
    locale: localeSchema,
    timeZone: timeZoneSchema,
    /** Stable request key supplied by the transport layer for replay safety. */
    idempotencyKey: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.channel === "self_service" && !value.userId)
      ctx.addIssue({ code: "custom", path: ["userId"], message: "account is required" });
    if (value.channel === "self_service" && value.subject)
      ctx.addIssue({
        code: "custom",
        path: ["subject"],
        message: "self-service identity comes from the authenticated account",
      });
    if (value.channel !== "self_service" && !value.userId && !value.subject)
      ctx.addIssue({ code: "custom", path: ["subject"], message: "subject locator is required" });
    if (value.subject?.accountState === "deleted" && value.userId)
      ctx.addIssue({
        code: "custom",
        path: ["userId"],
        message: "deleted accounts must not be recreated or linked",
      });
  });
export type CreateSubjectRequestInput = z.input<typeof createSubjectRequestSchema>;

/** Body of the self-service export: the account supplies the identity. */
export const selfServiceExportSchema = z
  .object({
    kind: requestKindSchema.default("access_and_portability"),
    locale: localeSchema,
    timeZone: timeZoneSchema,
  })
  .strict();

export const eventPayloadSchema = z
  .record(
    z.string().max(64),
    z.union([
      z.string().max(512),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(z.string().max(128)).max(32),
    ]),
  )
  .refine((payload) => JSON.stringify(payload).length <= 8_192, "event payload too large");

export function assertValidRequestTransition(from: RequestState, to: RequestState): void {
  if (!isValidRequestTransition(from, to)) throw new PrivacyRequestError("INVALID_TRANSITION", 409);
}
