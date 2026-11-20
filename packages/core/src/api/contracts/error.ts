import z from "zod/v4";

/**
 * The one error envelope of every API error reply: `error` is a short,
 * user-safe description and `code`, when present, a stable machine-readable
 * reason. A family adds its own fields (`retryAfter`, `details`, `errors`…)
 * by extending this schema; readers rely on `error` alone.
 */
export const apiErrorSchema = z.looseObject({
  error: z.string(),
  code: z.string().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
