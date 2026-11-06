/** Deliberately reduced public session; never includes token, IP or impersonation data. */
import z from "zod/v4";
export const publicSessionUserSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  image: z.string().nullable(),
  role: z.string().nullable(),
});
export const publicSessionSchema = z.strictObject({
  user: publicSessionUserSchema,
  session: z.strictObject({ expiresAt: z.iso.datetime({ offset: true }) }),
});
export type PublicSessionUser = z.infer<typeof publicSessionUserSchema>;
export type PublicSessionPayload = z.infer<typeof publicSessionSchema>;
