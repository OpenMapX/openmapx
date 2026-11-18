/** The configuration rows a save wrote, by row version, kept with the job's
 * candidate. No desired values or secret material. */
import { z } from "zod";

const version = z.string().regex(/^\d{1,10}$/),
  id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const configurationSavedRowSchema = z
  .strictObject({
    kind: z.enum([
      "service-config",
      "integration-config",
      "service-secret",
      "integration-secret",
      "platform",
    ]),
    ownerId: id,
    key: z.string().min(1).max(128).optional(),
    rowId: z.string().min(1).max(128),
    rowVersion: version.nullable(),
    previousRowVersion: version.nullable(),
    state: z.enum(["present", "absent"]),
  })
  .refine(
    (row) =>
      (row.kind !== "platform" ||
        (row.ownerId === "platform" &&
          row.rowId === "platformConfiguration" &&
          row.state === "present")) &&
      row.kind.endsWith("secret") === (row.key !== undefined) &&
      (row.state === "present" ? row.rowVersion !== null : row.rowVersion === null),
  );
export type ConfigurationSavedRow = z.infer<typeof configurationSavedRowSchema>;
