import { createHmac, timingSafeEqual } from "node:crypto";
import {
  canonicalJson,
  readOpsTokenFile,
  standaloneOwnershipInspectionSchema,
} from "@openmapx/core/ops";
import z from "zod/v4";
export const ownershipRequestSchema = z.strictObject({
  integrationId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  expectedContentDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
export const ownershipStateSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("ownership"),
  jobId: z.uuid(),
  operationId: z.uuid(),
  ownerId: z.string().max(128),
  action: z.enum(["adopt", "remove"]),
  request: ownershipRequestSchema,
  parentId: z.string().max(128).nullable(),
  before: z.string().max(65536),
  inspection: standaloneOwnershipInspectionSchema.nullable(),
  phase: z.enum([
    "prepared",
    "inspected",
    "removed",
    "reload_attempted",
    "reloaded",
    "persist_attempted",
    "persisted",
    "restore",
    "complete",
  ]),
  outcome: z.enum(["committed", "restored"]).nullable(),
});
export type OwnershipState = z.infer<typeof ownershipStateSchema>;
const token = () => readOpsTokenFile(process.env.OPS_AGENT_TOKEN_FILE ?? "");
export async function sealOwnershipState(state: OwnershipState) {
  const body = canonicalJson(ownershipStateSchema.parse(state));
  return {
    body,
    mac: createHmac("sha256", await token())
      .update("openmapx-standalone-ownership-v1\0")
      .update(body)
      .digest("hex"),
  };
}
export async function readOwnershipState(input: unknown) {
  const saved = z
      .strictObject({ body: z.string().max(131072), mac: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(input),
    expected = createHmac("sha256", await token())
      .update("openmapx-standalone-ownership-v1\0")
      .update(saved.body)
      .digest();
  if (!timingSafeEqual(expected, Buffer.from(saved.mac, "hex")))
    throw Error("Ownership checkpoint authentication failed");
  return ownershipStateSchema.parse(JSON.parse(saved.body));
}
export async function authenticateOwnershipRequest(type: string, payload: Record<string, unknown>) {
  const request = ownershipRequestSchema.parse({
    integrationId: payload.integrationId,
    expectedContentDigest: payload.expectedContentDigest,
  });
  const expected = createHmac("sha256", await token())
    .update("openmapx-standalone-request-v1\0")
    .update(canonicalJson({ type, payload: request, actorId: payload.ownerId }))
    .digest("hex");
  if (
    payload.ownerId !== payload._standaloneActor ||
    payload._requestDigest !== expected ||
    !z.uuid().safeParse(payload.operationId).success ||
    typeof payload.ownerId !== "string"
  )
    throw Error("Ownership request authentication failed");
  return { request, ownerId: payload.ownerId, operationId: String(payload.operationId) };
}
