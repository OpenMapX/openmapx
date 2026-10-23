import type { FastifyListenOptions } from "fastify";
import type { AdministrativeReleaseEffects } from "./administrative-runtime";
import { type BuildOpsAgentServerOptions, buildOpsAgentServer } from "./server";

/** Production assembly, after token and configuration authority validation. */
export async function startOpsAgentServer(
  options: BuildOpsAgentServerOptions,
  releaseEffects: Pick<AdministrativeReleaseEffects, "initialize">,
  listen: FastifyListenOptions,
  onReleaseReady?: () => void,
) {
  let ready = false;
  try {
    await releaseEffects.initialize?.();
    ready = true;
  } catch {
    // Retain the transaction for explicit reconciliation; never retry unknown effects here.
  }
  const app = buildOpsAgentServer({
    ...options,
    releaseRecovery: { ready, ...(!ready ? { reason: "recovery_required" as const } : {}) },
  });
  await app.listen(listen);
  if (ready) onReleaseReady?.();
  return app;
}
