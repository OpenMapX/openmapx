import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import z from "zod/v4";
import { db as defaultDb } from "../db/index.js";
import { dataDisclosureEvent } from "../db/schema.js";
import { getSubjectDataRegistration } from "./catalogue.js";

const code = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
export const disclosureInputSchema = z
  .object({
    /** `userId` is retained as a source-compatible alias for older call sites. */
    userId: z.string().min(1).max(256).nullable().optional(),
    subjectUserId: z.string().min(1).max(256).nullable().optional(),
    occurredAt: z.coerce.date(),
    recipientId: code,
    // The following legacy fields may be supplied only when they exactly match
    // the trusted recipient snapshot. New code should not send them.
    recipientName: z.string().min(1).max(256).optional(),
    recipientRole: code.optional(),
    recipientCountry: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable()
      .optional(),
    recipientPrivacyUrl: z.url().nullable().optional(),
    integrationId: code.nullable().optional(),
    operationCode: code,
    categoryCode: code,
    purposeCode: code,
    legalBasisCode: code,
    transferSafeguardCode: code.nullable().optional(),
    externalReference: z.string().max(512).nullable().optional(),
    idempotencyKey: code.optional(),
  })
  .strict();
export type DisclosureInput = z.infer<typeof disclosureInputSchema>;

export interface TrustedRecipient {
  id: string;
  name: string;
  role: "controller" | "processor" | "independent-controller" | "public-recipient" | "operator";
  country: string | null;
  privacyUrl: string | null;
}

/** Legal facts are application-owned, not caller-owned. Deployment settings
 * may later override names/URLs through a reviewed registry; unknown IDs fail
 * closed so a typo cannot fabricate a recipient in an Article 15 report. */
export const TRUSTED_RECIPIENTS: Readonly<Record<string, TrustedRecipient>> = Object.freeze({
  "openmapx-controller": {
    id: "openmapx-controller",
    name: "Deployment controller",
    role: "controller",
    country: null,
    privacyUrl: null,
  },
  "dawarich-managed": {
    id: "dawarich-managed",
    name: "Managed Dawarich processor",
    role: "processor",
    country: null,
    privacyUrl: "https://dawarich.app/privacy",
  },
  "mangrove-reviews": {
    id: "mangrove-reviews",
    name: "Mangrove Reviews",
    role: "independent-controller",
    country: null,
    privacyUrl: "https://mangrove.reviews/privacy",
  },
  "public-recipient": {
    id: "public-recipient",
    name: "Recipients of a user-published public link",
    role: "public-recipient",
    country: null,
    privacyUrl: null,
  },
  "email-processor": {
    id: "email-processor",
    name: "Configured email delivery processor",
    role: "processor",
    country: null,
    privacyUrl: null,
  },
  openstreetmap: {
    id: "openstreetmap",
    name: "OpenStreetMap API",
    role: "independent-controller",
    country: null,
    privacyUrl: "https://wiki.osmfoundation.org/wiki/Privacy_Policy",
  },
  osm: {
    id: "osm",
    name: "OpenStreetMap",
    role: "independent-controller",
    country: "GB",
    privacyUrl: null,
  },
  // Keep a policy URL here, never an interactive map URL.  The recipient
  // snapshot is used in Article 15 responses and must remain useful after a
  // deployment changes its integration configuration.
  mapillary: {
    id: "mapillary",
    name: "Mapillary",
    role: "independent-controller",
    country: "US",
    privacyUrl: "https://www.mapillary.com/privacy",
  },
});

const EXTRA_CATEGORIES = new Set([
  "osm-publication",
  "email-delivery",
  "timeline-processing",
  "managed-dawarich",
  "mangrove-publication",
]);

function trustedRecipient(recipientId: string): TrustedRecipient {
  const recipient = TRUSTED_RECIPIENTS[recipientId];
  if (!recipient) throw new Error("Unknown disclosure recipient");
  return recipient;
}

function validateAgainstCatalogue(value: {
  recipientId: string;
  categoryCode: string;
  purposeCode: string;
  legalBasisCode: string;
}): void {
  const registration = getSubjectDataRegistration(value.categoryCode);
  if (!registration) {
    if (!EXTRA_CATEGORIES.has(value.categoryCode)) throw new Error("Unknown disclosure category");
    return;
  }
  if (!registration.purposes.includes(value.purposeCode as never))
    throw new Error("Disclosure purpose is not registered for category");
  if (!registration.legalBases.includes(value.legalBasisCode as never))
    throw new Error("Disclosure legal basis is not registered for category");
  if (!registration.recipients.some((recipient) => recipient.id === value.recipientId))
    throw new Error("Disclosure recipient is not registered for category");
}

export function sanitizeDisclosureInput(value: DisclosureInput): Omit<
  DisclosureInput,
  | "externalReference"
  | "idempotencyKey"
  | "subjectUserId"
  | "userId"
  | "recipientName"
  | "recipientRole"
  | "recipientCountry"
  | "recipientPrivacyUrl"
> & {
  userId: string | null;
  recipientName: string;
  recipientRole: string;
  recipientCountry: string | null;
  recipientPrivacyUrl: string | null;
  externalReferenceDigest: string | null;
  idempotencyKey?: string;
} {
  const parsed = disclosureInputSchema.parse(value);
  const recipient = trustedRecipient(parsed.recipientId);
  validateAgainstCatalogue({
    recipientId: parsed.recipientId,
    categoryCode: parsed.categoryCode,
    purposeCode: parsed.purposeCode,
    legalBasisCode: parsed.legalBasisCode,
  });
  const userId = parsed.subjectUserId ?? parsed.userId ?? null;
  if (parsed.subjectUserId && parsed.userId && parsed.subjectUserId !== parsed.userId)
    throw new Error("Conflicting subject user IDs");
  for (const [provided, canonical] of [
    [parsed.recipientName, recipient.name],
    [parsed.recipientRole, recipient.role],
    [parsed.recipientCountry, recipient.country],
    [parsed.recipientPrivacyUrl, recipient.privacyUrl],
  ] as const) {
    if (provided !== undefined && provided !== canonical)
      throw new Error("Recipient facts are controlled by the registry");
  }
  return {
    userId,
    occurredAt: parsed.occurredAt,
    recipientId: parsed.recipientId,
    recipientName: recipient.name,
    recipientRole: recipient.role,
    recipientCountry: recipient.country,
    recipientPrivacyUrl: recipient.privacyUrl,
    integrationId: parsed.integrationId ?? null,
    operationCode: parsed.operationCode,
    categoryCode: parsed.categoryCode,
    purposeCode: parsed.purposeCode,
    legalBasisCode: parsed.legalBasisCode,
    transferSafeguardCode: parsed.transferSafeguardCode ?? null,
    externalReferenceDigest: parsed.externalReference
      ? createHash("sha256").update(parsed.externalReference).digest("hex")
      : null,
    ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
  };
}

export async function recordDataDisclosure(
  value: DisclosureInput,
  database: typeof defaultDb = defaultDb,
): Promise<void> {
  const safe = sanitizeDisclosureInput(value);
  try {
    await database.insert(dataDisclosureEvent).values(safe as never);
  } catch (error) {
    // Stable operation IDs are idempotent. Other failures must surface so the
    // caller can reconcile an external disclosure without pretending success.
    if (safe.idempotencyKey && String(error).toLowerCase().includes("duplicate")) return;
    throw error;
  }
}

/** Best-effort reconciliation hook for an irreversible processor/publication
 * call. It never turns a successful upstream operation into a client failure;
 * an operator metric/outbox can retry the same idempotency key. */
export async function recordDataDisclosureBestEffort(
  value: DisclosureInput,
  database: typeof defaultDb = defaultDb,
): Promise<void> {
  try {
    await recordDataDisclosure(value, database);
  } catch {
    /* reconcile asynchronously; never break the upstream action */
  }
}

export async function listDisclosuresForUser(
  userId: string,
  database: typeof defaultDb = defaultDb,
) {
  return database
    .select({
      occurredAt: dataDisclosureEvent.occurredAt,
      recipientId: dataDisclosureEvent.recipientId,
      recipientName: dataDisclosureEvent.recipientName,
      recipientRole: dataDisclosureEvent.recipientRole,
      recipientCountry: dataDisclosureEvent.recipientCountry,
      recipientPrivacyUrl: dataDisclosureEvent.recipientPrivacyUrl,
      integrationId: dataDisclosureEvent.integrationId,
      operationCode: dataDisclosureEvent.operationCode,
      categoryCode: dataDisclosureEvent.categoryCode,
      purposeCode: dataDisclosureEvent.purposeCode,
      legalBasisCode: dataDisclosureEvent.legalBasisCode,
      transferSafeguardCode: dataDisclosureEvent.transferSafeguardCode,
    })
    .from(dataDisclosureEvent)
    .where(eq(dataDisclosureEvent.userId, userId));
}
