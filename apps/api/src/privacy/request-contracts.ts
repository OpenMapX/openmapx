import { defaultLocale } from "@openmapx/i18n";
import z from "zod/v4";
import {
  REQUEST_CHANNELS,
  REQUEST_KINDS,
  REQUEST_STATES,
  type RequestState,
  TASK_STATES,
  type TaskState,
} from "../db/privacy-schema.js";

const uuid = z.uuid();
const stableCode = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/)
  .max(128);

export const requestKindSchema = z.enum(REQUEST_KINDS);
export const requestChannelSchema = z.enum(REQUEST_CHANNELS);
export const requestStateSchema = z.enum(REQUEST_STATES);
export const taskStateSchema = z.enum(TASK_STATES);

export const assistedSubjectSchema = z
  .object({
    locatorType: z.enum(["user_id", "email", "username", "erasure_reference", "other_reference"]),
    locator: z.string().trim().min(1).max(512),
    accountState: z.enum(["current", "inaccessible", "deleted", "unknown"]),
  })
  .strict();

export const representativeIntakeSchema = z
  .object({
    contactType: z.enum(["email", "other_reference"]),
    contact: z.string().trim().min(1).max(512),
  })
  .strict();

export const createSubjectRequestSchema = z
  .object({
    kind: requestKindSchema.default("access_and_portability"),
    channel: requestChannelSchema.default("self_service"),
    userId: z.string().min(1).max(256).nullable().optional().default(null),
    subject: assistedSubjectSchema.optional(),
    representative: representativeIntakeSchema.optional(),
    actorUserId: z.string().min(1).max(256).nullable().optional(),
    actorSessionId: z.string().min(1).max(256).nullable().optional(),
    receivedAt: z.coerce.date().optional(),
    locale: z
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
      .default(defaultLocale),
    timeZone: z.string().min(1).max(64).default("UTC"),
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
    if (value.channel === "representative" && !value.representative)
      ctx.addIssue({
        code: "custom",
        path: ["representative"],
        message: "representative contact is required",
      });
    if (value.subject?.accountState === "deleted" && value.userId)
      ctx.addIssue({
        code: "custom",
        path: ["userId"],
        message: "deleted accounts must not be recreated or linked",
      });
  });
export type CreateSubjectRequestInput = z.input<typeof createSubjectRequestSchema>;

export const transitionRequestSchema = z
  .object({
    requestId: uuid,
    from: requestStateSchema,
    to: requestStateSchema,
    version: z.number().int().positive(),
    reasonCode: stableCode.optional(),
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

export const requestIdParamSchema = z.object({ requestId: uuid }).strict();
export const artifactIdParamSchema = z.object({ requestId: uuid, artifactId: uuid }).strict();
export const reauthCompleteSchema = z.object({ challengeId: uuid }).strict();
export const identityOutcomeSchema = z
  .object({
    version: z.number().int().positive(),
    state: z.enum(["verified", "failed", "clarification"]),
  })
  .strict();

export {
  assistedReauthStartSchema,
  emailIdentityChallengeCompleteSchema,
  emailIdentityChallengeIssueSchema,
  identityReviewSchema,
  taskAssignmentSchema,
  taskDecisionSchema,
} from "@openmapx/core/privacy";

export interface RequestTransition {
  from: RequestState;
  to: RequestState;
}

const transitionPairs: readonly RequestTransition[] = [
  { from: "received", to: "identity_pending" },
  { from: "received", to: "preserving" },
  { from: "identity_pending", to: "preserving" },
  { from: "identity_pending", to: "clarification_needed" },
  { from: "preserving", to: "collecting" },
  { from: "preserving", to: "clarification_needed" },
  { from: "collecting", to: "pending_processor" },
  { from: "collecting", to: "operator_review" },
  { from: "collecting", to: "clarification_needed" },
  { from: "collecting", to: "assembling" },
  { from: "pending_processor", to: "collecting" },
  { from: "pending_processor", to: "assembling" },
  { from: "pending_processor", to: "clarification_needed" },
  { from: "operator_review", to: "collecting" },
  { from: "operator_review", to: "assembling" },
  { from: "operator_review", to: "clarification_needed" },
  // Technical crash recovery: an interrupted assembly is retried from the
  // collecting state.  This is not a legal refusal or completion decision;
  // the durable event records why the state moved backwards.
  { from: "assembling", to: "collecting" },
  { from: "clarification_needed", to: "preserving" },
  { from: "clarification_needed", to: "operator_review" },
  { from: "assembling", to: "ready" },
  { from: "ready", to: "delivered" },
  { from: "ready", to: "artifact_expired" },
  { from: "artifact_expired", to: "closed" },
  { from: "delivered", to: "closed" },
];

const transitionSet = new Set(transitionPairs.map(({ from, to }) => `${from}->${to}`));
export const REQUEST_TRANSITIONS = Object.freeze(transitionPairs);

export function isValidRequestTransition(from: RequestState, to: RequestState): boolean {
  if (from === to) return false;
  if (to === "withdrawn" || to === "refused")
    return !["delivered", "artifact_expired", "closed"].includes(from);
  return transitionSet.has(`${from}->${to}`);
}

export function assertValidRequestTransition(from: RequestState, to: RequestState): void {
  if (!isValidRequestTransition(from, to))
    throw new Error(`Invalid privacy request transition: ${from} -> ${to}`);
}

export function canAssembleTaskState(status: TaskState, required: boolean): boolean {
  return !required || ["complete", "not_applicable"].includes(status);
}

export function assertAssemblyReady(
  tasks: readonly { status: TaskState; required: boolean }[],
): void {
  if (!tasks.length || tasks.some((task) => !canAssembleTaskState(task.status, task.required))) {
    throw new Error("Privacy request has unresolved required source tasks");
  }
}

export function isAssistedDeliveryAuthorized(
  identities: ReadonlyArray<{
    party: string;
    state: string;
    authorityState: string;
    deliveryAuthorized: number;
  }>,
  channel: "assisted" | "representative",
): boolean {
  const subject = identities.find((identity) => identity.party === "subject");
  if (subject?.state !== "verified") return false;
  if (channel === "assisted") return true;
  const representative = identities.find((identity) => identity.party === "representative");
  return (
    representative?.state === "verified" &&
    representative.authorityState === "approved" &&
    representative.deliveryAuthorized === 1
  );
}
