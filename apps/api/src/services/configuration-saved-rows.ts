/** The configuration rows a save wrote, by row version, kept with the job's
 * candidate. No desired values or secret material. */
import { COMPONENT_ID_PATTERN } from "@openmapx/core/component-id";
import { z } from "zod";

const version = z.string().regex(/^\d{1,10}$/),
  id = z.string().regex(COMPONENT_ID_PATTERN);
export const configurationSavedRowSchema = z
  .strictObject({
    kind: z.enum([
      "service-config",
      "integration-config",
      "service-secret",
      "integration-secret",
      "platform",
    ]),
    /** With `key` for a secret, the row's natural key. */
    ownerId: id,
    key: z.string().min(1).max(128).optional(),
    rowVersion: version.nullable(),
    previousRowVersion: version.nullable(),
    state: z.enum(["present", "absent"]),
  })
  .refine(
    (row) =>
      (row.kind !== "platform" || (row.ownerId === "platform" && row.state === "present")) &&
      row.kind.endsWith("secret") === (row.key !== undefined) &&
      (row.state === "present" ? row.rowVersion !== null : row.rowVersion === null),
  );
export type ConfigurationSavedRow = z.infer<typeof configurationSavedRowSchema>;
