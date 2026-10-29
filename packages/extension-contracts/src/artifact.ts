import z from "zod/v4";
import { PLATFORM_VERSION, satisfiesPlatformVersion } from "./platform";

/** Archive-envelope format version; independent of the extension protocol. */
export const ARTIFACT_SCHEMA_VERSION = 1;
export const artifactMetadataSchema = z
  .object({
    schemaVersion: z.literal(ARTIFACT_SCHEMA_VERSION),
    id: z.string().min(1),
    platformVersion: z.string(),
    builtAt: z.string(),
  })
  .strict();
export type ArtifactMetadata = z.infer<typeof artifactMetadataSchema>;
export function validateArtifactMetadata(
  raw: unknown,
  expectedId: string,
  current = PLATFORM_VERSION,
): { valid: boolean; errors: string[] } {
  const result = artifactMetadataSchema.safeParse(raw);
  if (!result.success)
    return {
      valid: false,
      errors: result.error.issues.map(
        (issue) => `invalid shape: ${issue.path.join(".")}: ${issue.message}`,
      ),
    };
  const errors: string[] = [];
  if (result.data.id !== expectedId) errors.push(`id mismatch: expected ${expectedId}`);
  if (!satisfiesPlatformVersion(result.data.platformVersion, current))
    errors.push(
      `platform version mismatch: ${result.data.platformVersion} is not compatible with ${current}`,
    );
  return { valid: errors.length === 0, errors };
}
