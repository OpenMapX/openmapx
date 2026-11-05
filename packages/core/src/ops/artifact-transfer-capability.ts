/** Server-only API↔agent bearer proof. Never send this capability to a browser. */
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import z from "zod/v4";
import { artifactStageClaimSchema, transferPurposeSchema } from "./artifact-transfer";
import { canonicalJson } from "./canonical-json";
export const artifactStreamCapabilitySchema = z.strictObject({
  version: z.literal(1),
  stageId: z.uuid(),
  ownerId: z.string().min(1).max(128),
  purpose: transferPurposeSchema,
  direction: z.enum(["upload", "download"]),
  byteCap: z.number().int().safe().nonnegative(),
  claim: artifactStageClaimSchema.optional(),
  attemptId: z.uuid(),
  issuedAt: z.number().int().safe(),
  expiresAt: z.number().int().safe(),
  deadlineAt: z.number().int().safe(),
});
export type ArtifactStreamCapability = z.infer<typeof artifactStreamCapabilitySchema>;
function key(token: string) {
  return Buffer.from(
    hkdfSync("sha256", token, "openmapx-artifact-transfer-v1", "stream-capability", 32),
  );
}
export function issueArtifactStreamCapability(
  token: string,
  input: ArtifactStreamCapability,
): string {
  const value = artifactStreamCapabilitySchema.parse(input);
  if (
    value.expiresAt <= value.issuedAt ||
    value.expiresAt - value.issuedAt > 60000 ||
    value.deadlineAt <= value.issuedAt ||
    value.deadlineAt - value.issuedAt > 7 * 86400_000
  )
    throw Error("Invalid artifact stream lifetime");
  const body = Buffer.from(canonicalJson(value)).toString("base64url");
  return `atcap1.${body}.${createHmac("sha256", key(token)).update(`artifact-transfer-v1.${body}`).digest("base64url")}`;
}
export function verifyArtifactStreamCapability(
  token: string,
  input: string,
  now = Date.now(),
): ArtifactStreamCapability {
  if (input.length > 8192) throw Error("Invalid artifact stream capability");
  const match = /^atcap1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(input);
  if (!match) throw Error("Invalid artifact stream capability");
  const actual = createHmac("sha256", key(token))
    .update(`artifact-transfer-v1.${match[1]}`)
    .digest();
  const supplied = Buffer.from(match[2], "base64url");
  if (supplied.length !== actual.length || !timingSafeEqual(supplied, actual))
    throw Error("Invalid artifact stream capability");
  const value = artifactStreamCapabilitySchema.parse(
    JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")),
  );
  if (
    now < value.issuedAt - 5000 ||
    now >= value.expiresAt ||
    value.expiresAt - value.issuedAt > 60000 ||
    value.deadlineAt <= now ||
    value.deadlineAt - value.issuedAt > 7 * 86400_000
  )
    throw Error("Expired artifact stream capability");
  return value;
}
