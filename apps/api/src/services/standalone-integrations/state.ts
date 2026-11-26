import { standaloneInstallRequestSchema } from "@openmapx/core/api-contracts";
import {
  canonicalJson,
  standaloneInstallInspectionSchema,
  standaloneInstallSourceSchema,
} from "@openmapx/core/ops";
import z from "zod/v4";
// Keeps the sealed state well inside its size limit whatever an integration throws.
export const LOAD_FAILURE_MAX_LENGTH = 2048;
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
  /** Why the reload left the installed integration out, when it did. */
  loadFailure: z.string().max(LOAD_FAILURE_MAX_LENGTH).optional(),
});
export type StandaloneState = z.infer<typeof standaloneStateSchema>;

export function sealStandaloneState(state: StandaloneState) {
  return { body: canonicalJson(standaloneStateSchema.parse(state)) };
}
export function readStandaloneState(value: unknown): StandaloneState {
  const sealed = z.strictObject({ body: z.string().max(16384) }).parse(value);
  return standaloneStateSchema.parse(JSON.parse(sealed.body));
}
