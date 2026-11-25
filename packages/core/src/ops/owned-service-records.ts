/** Portable observations only; parsing confers no ownership authority. */
import { z } from "zod";
import { COMPONENT_ID_PATTERN } from "../component-id";
export const ownedServiceSnapshotSchema = z.strictObject({
  serviceId: z.string().regex(COMPONENT_ID_PATTERN),
  containerId: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["running", "stopped", "created", "restarting", "paused", "unknown"]),
  provenance: z.strictObject({
    project: z.string().min(1).max(128),
    composeWorkingDirectory: z.string().min(1).max(4096),
    composeConfigFiles: z.array(z.string().min(1).max(4096)).min(1).max(2),
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }),
});
