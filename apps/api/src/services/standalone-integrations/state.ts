import { createHmac, timingSafeEqual } from "node:crypto";
import { standaloneInstallRequestSchema } from "@openmapx/core/api-contracts";
import {
  canonicalJson,
  readOpsTokenFile,
  standaloneInstallInspectionSchema,
  standaloneInstallSourceSchema,
} from "@openmapx/core/ops";
import z from "zod/v4";
export const standaloneStateSchema = z.strictObject({
  version: z.literal(1),
  jobId: z.uuid(),
  operationId: z.uuid(),
  ownerId: z.string().min(1).max(128),
  request: standaloneInstallRequestSchema,
  source: standaloneInstallSourceSchema,
  inspection: standaloneInstallInspectionSchema,
  parentId: z.string().regex(/^local-[a-f0-9-]{36}$/),
  phase: z.enum([
    "prepared",
    "published",
    "reload_attempted",
    "reloaded",
    "persist_attempted",
    "persisted",
    "restore",
    "complete",
  ]),
  outcome: z.enum(["committed", "restored"]).nullable(),
});
export type StandaloneState = z.infer<typeof standaloneStateSchema>;

export async function sealStandaloneState(state: StandaloneState) {
  const body = canonicalJson(standaloneStateSchema.parse(state));
  const token = await readOpsTokenFile(process.env.OPS_AGENT_TOKEN_FILE ?? "");
  const mac = createHmac("sha256", token)
    .update("openmapx-standalone-install-state-v1\0")
    .update(body)
    .digest("hex");
  return { body, mac };
}
export async function readStandaloneState(value: unknown): Promise<StandaloneState> {
  const sealed = z
    .strictObject({ body: z.string().max(16384), mac: z.string().regex(/^[a-f0-9]{64}$/) })
    .parse(value);
  const token = await readOpsTokenFile(process.env.OPS_AGENT_TOKEN_FILE ?? "");
  const expected = createHmac("sha256", token)
    .update("openmapx-standalone-install-state-v1\0")
    .update(sealed.body)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(sealed.mac, "hex")))
    throw Error("Standalone checkpoint authentication failed");
  return standaloneStateSchema.parse(JSON.parse(sealed.body));
}
