import z from "zod/v4";

export const ATTENTION_SEVERITIES = ["info", "warning", "critical"] as const;
export type AttentionSeverity = (typeof ATTENTION_SEVERITIES)[number];
/** How an item ends: `condition` only when its source clears it, `acknowledge` also when an administrator acknowledges it. */
export const ATTENTION_CLEARANCES = ["condition", "acknowledge"] as const;
export type AttentionClearance = (typeof ATTENTION_CLEARANCES)[number];
export const ATTENTION_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,199}$/;
export const ATTENTION_TITLE_MAX_LENGTH = 200;
export const ATTENTION_DETAIL_MAX_LENGTH = 2_000;
export const ATTENTION_OCCURRENCE_REF_MAX_LENGTH = 128;
// An item is shown to administrators, so its link stays inside the admin area
// and can never become an outbound link. A `.` or `..` segment is refused: the
// browser resolves it, so `/admin/../api` would leave the area.
export const attentionActionSchema = z.strictObject({
  label: z.string().min(1).max(120),
  href: z
    .string()
    .max(512)
    .regex(/^\/admin(?:\/(?!\.\.?(?:[/?]|$))[A-Za-z0-9._~-]+)*(?:\?[A-Za-z0-9._~=&-]*)?$/),
});
export type AttentionAction = z.infer<typeof attentionActionSchema>;
export const attentionInputSchema = z.strictObject({
  key: z.string().regex(ATTENTION_KEY_PATTERN),
  severity: z.enum(ATTENTION_SEVERITIES),
  source: z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/),
  title: z.string().min(1).max(ATTENTION_TITLE_MAX_LENGTH),
  detail: z.string().min(1).max(ATTENTION_DETAIL_MAX_LENGTH).optional(),
  action: attentionActionSchema.optional(),
  clearance: z.enum(ATTENTION_CLEARANCES).optional(),
  occurrenceRef: z.string().min(1).max(ATTENTION_OCCURRENCE_REF_MAX_LENGTH).optional(),
});
export type AttentionInput = z.infer<typeof attentionInputSchema>;
export const attentionItemSchema = z.strictObject({
  key: z.string(),
  severity: z.enum(ATTENTION_SEVERITIES),
  source: z.string(),
  title: z.string(),
  detail: z.string().nullable(),
  action: attentionActionSchema.nullable(),
  clearance: z.enum(ATTENTION_CLEARANCES),
  acknowledgedAt: z.string().nullable(),
  raisedAt: z.string(),
  updatedAt: z.string(),
});
export type AttentionItem = z.infer<typeof attentionItemSchema>;
export const adminAttentionListSchema = z.strictObject({ items: z.array(attentionItemSchema) });
export const adminAttentionKeyParamsSchema = z.strictObject({
  key: z.string().regex(ATTENTION_KEY_PATTERN),
});
