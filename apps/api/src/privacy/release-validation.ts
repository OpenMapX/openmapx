import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import z from "zod/v4";
import type { ReadinessReleaseContractChecks } from "./readiness.js";

const failedChecks = Object.freeze({
  translationsConsistent: false,
  openApiConsistent: false,
  policyConsistent: false,
});

const validationSchema = z
  .object({
    version: z.literal(1),
    sourceBuildFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    validatedAt: z.iso.datetime({ offset: true }),
    checks: z
      .object({
        translationsConsistent: z.literal(true),
        openApiConsistent: z.literal(true),
        policyConsistent: z.literal(true),
      })
      .strict(),
  })
  .strict();

/** Load non-personal machine evidence produced after the three repository
 * validators pass. A copied file from another build can never open readiness. */
export async function loadPrivacyReleaseValidationChecks(
  path: string,
  sourceBuildFingerprint: string,
): Promise<ReadinessReleaseContractChecks> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!isAbsolute(path) || !/^[a-f0-9]{64}$/.test(sourceBuildFingerprint)) return failedChecks;
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > 16_384)
      return failedChecks;
    const parsed = validationSchema.safeParse(JSON.parse(await handle.readFile("utf8")));
    if (!parsed.success || parsed.data.sourceBuildFingerprint !== sourceBuildFingerprint)
      return failedChecks;
    return parsed.data.checks;
  } catch {
    return failedChecks;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function resolvePrivacyReleaseValidationChecks(
  sourceBuildFingerprint: string,
  env: Record<string, string | undefined> = process.env,
): Promise<ReadinessReleaseContractChecks> {
  const path = env.PRIVACY_EXPORT_VALIDATION_EVIDENCE_FILE?.trim();
  return path ? loadPrivacyReleaseValidationChecks(path, sourceBuildFingerprint) : failedChecks;
}
